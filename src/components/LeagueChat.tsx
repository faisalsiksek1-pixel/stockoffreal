"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { deleteLeagueMessage, getLeagueMessagesAction, postLeagueMessage } from "@/actions/chat";
import { competitorIdentity } from "@/components/CompetitorCard";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { chatTime } from "@/lib/format";
import type { ChatMessage } from "@/lib/types";

const POLL_MS = 4500;

/**
 * A league's chat thread. Polls rather than subscribing to Realtime — this
 * app has no websocket precedent anywhere (see 0009_league_chat.sql's
 * header), and a few seconds of staleness here is smaller than the
 * staleness this app already accepts for pending limit orders.
 *
 * `pending` (useTransition) covers sending only — a poll tick must never
 * toggle it, or the whole panel would visibly grey out every ~4.5s.
 */
export function LeagueChat({
  leagueId,
  myPortfolioId,
  isAdmin,
  initialMessages,
  myTeam = null,
}: {
  leagueId: string;
  myPortfolioId: string;
  isAdmin: boolean;
  initialMessages: ChatMessage[];
  myTeam?: { id: string; name: string } | null;
}) {
  const [channel, setChannel] = useState<"league" | "team">("league");
  const activeTeamId = channel === "team" && myTeam ? myTeam.id : null;
  const [messages, setMessages] = useState(initialMessages);
  const [sendError, setSendError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Separate transitions so deleting one message never disables the Send
  // button (or vice versa) — they are unrelated actions sharing one panel.
  const [sending, startSend] = useTransition();
  const [deleting, startDelete] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reqSeq = useRef(0);

  async function refresh() {
    const seq = ++reqSeq.current;
    const res = await getLeagueMessagesAction(leagueId, activeTeamId);
    // A slower earlier request can resolve after a newer one — ignore it
    // rather than overwrite fresher state with stale data.
    if (seq !== reqSeq.current) return;
    if (res.ok) setMessages(res.messages);
    // Silent on failure: only explicit send/delete actions surface an Alert,
    // never a background poll tick.
  }

  function restartInterval() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(refresh, POLL_MS);
  }

  useEffect(() => {
    if (channel === "league") {
      // Server-fetched, instant — no need to wait on a round trip.
      setMessages(initialMessages);
    } else {
      setMessages([]);
      refresh();
    }
    restartInterval();

    function onVisibility() {
      if (document.hidden) {
        if (intervalRef.current) clearInterval(intervalRef.current);
      } else {
        refresh();
        restartInterval();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Deliberately only depends on leagueId/channel: refresh/restartInterval
    // close over state via the functions above, not via this effect's closure.
  }, [leagueId, channel]);

  function handleDelete(id: string) {
    setDeletingId(id);
    startDelete(async () => {
      const res = await deleteLeagueMessage(id);
      setDeletingId(null);
      if (res.ok) {
        await refresh();
      } else {
        setSendError(res.error);
      }
    });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted">
          {channel === "team" && myTeam ? `${myTeam.name} chat` : "League chat"}
        </h2>
        {myTeam ? (
          <SegmentedControl
            fullWidth={false}
            options={[
              { value: "league", label: "League" },
              { value: "team", label: myTeam.name },
            ]}
            value={channel}
            onChange={setChannel}
          />
        ) : null}
      </div>

      {messages.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-5 py-8 text-center text-sm text-muted">
          No messages yet, say hello.
        </p>
      ) : (
        <ul className="max-h-96 divide-y divide-line overflow-y-auto overflow-x-hidden rounded-2xl border border-line bg-surface">
          {messages.map((m) => {
            const special = m.ownerType !== "user";
            const id = competitorIdentity(m.ownerType);
            const isMine = m.senderPortfolioId === myPortfolioId;
            const canDelete = isMine || isAdmin;
            return (
              <li key={m.id} className="px-3 py-2.5 sm:px-4">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-semibold ${special ? id.accent : ""}`}>
                    {m.displayName}
                  </span>
                  {special ? <Badge tone={id.tone}>{id.label}</Badge> : null}
                  {isMine ? <Badge tone="ai">You</Badge> : null}
                  <span
                    className="tnum ml-auto shrink-0 text-xs text-muted"
                    title={new Date(m.createdAt).toLocaleString()}
                  >
                    {chatTime(m.createdAt)}
                  </span>
                  {canDelete ? (
                    <button
                      type="button"
                      onClick={() => handleDelete(m.id)}
                      disabled={deleting && deletingId === m.id}
                      aria-label="Delete message"
                      className="shrink-0 text-muted transition hover:text-down"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{m.body}</p>
              </li>
            );
          })}
        </ul>
      )}

      {sendError ? (
        <div className="mt-2">
          <Alert>{sendError}</Alert>
        </div>
      ) : null}

      <form
        ref={formRef}
        action={(formData) => {
          setSendError(null);
          startSend(async () => {
            const res = await postLeagueMessage(formData);
            if (res.ok) {
              formRef.current?.reset();
              await refresh();
              restartInterval();
            } else {
              setSendError(res.error);
            }
          });
        }}
        className="mt-3 flex gap-2"
      >
        <input type="hidden" name="leagueId" value={leagueId} />
        <input type="hidden" name="teamId" value={activeTeamId ?? ""} />
        <Input name="body" maxLength={500} required placeholder="Say something…" className="flex-1" />
        <Button type="submit" disabled={sending} className="shrink-0">
          {sending ? "Sending…" : "Send"}
        </Button>
      </form>
    </div>
  );
}
