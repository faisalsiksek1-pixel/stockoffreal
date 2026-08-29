"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { createLeague, createTeam, joinLeague, joinTeam, startAiDuel } from "@/actions/leagues";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { COMPETITION_COOKIE } from "@/lib/types";

/** So the dashboard shows the competition just created/joined next time it is
 *  visited, instead of falling back to the flagship. */
function selectCompetition(leagueId: string) {
  document.cookie = `${COMPETITION_COOKIE}=${leagueId}; path=/; max-age=31536000; samesite=lax`;
}

export function CreateLeagueForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Only row identity (for React keys) is tracked here, not the typed
  // values — every row shares name="teamName", so the browser's own
  // FormData collects whatever was typed via formData.getAll("teamName") on
  // submit, same as every other uncontrolled input in this file.
  const [teamRowIds, setTeamRowIds] = useState<string[]>([]);
  const router = useRouter();

  return (
    <form
      action={(formData) => {
        setError(null);
        start(async () => {
          const res = await createLeague(formData);
          if (res.ok) {
            selectCompetition(res.id);
            router.push(`/leagues/${res.code}`);
          } else setError(res.error);
        });
      }}
      className="space-y-3"
    >
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <label htmlFor="league-name" className="mb-1.5 block text-sm font-medium">
          League name
        </label>
        <Input
          id="league-name"
          name="name"
          required
          minLength={3}
          maxLength={40}
          placeholder="Sixth form stock club"
        />
      </div>

      <div>
        <span className="mb-1.5 block text-sm font-medium">Teams (optional)</span>
        <div className="space-y-2">
          {teamRowIds.map((id) => (
            <div key={id} className="flex gap-2">
              <Input name="teamName" maxLength={40} placeholder="Team name" className="flex-1" />
              <button
                type="button"
                onClick={() => setTeamRowIds((ids) => ids.filter((x) => x !== id))}
                aria-label="Remove team"
                className="text-xs text-muted transition hover:text-down"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setTeamRowIds((ids) => [...ids, crypto.randomUUID()])}
          className="mt-2 text-xs font-medium text-ai hover:underline"
        >
          + Add a team
        </button>
        <p className="mt-1.5 text-xs text-muted">
          Each team gets its own join code, separate from the league&rsquo;s.
        </p>
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create league"}
      </Button>
    </form>
  );
}

/**
 * One-click accept for someone arriving on an invite link. They already have the
 * code in the URL, so making them retype it into the join form would be silly.
 */
export function AcceptInviteButton({ code }: { code: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-3">
      {error ? <Alert>{error}</Alert> : null}
      <Button
        type="button"
        disabled={pending}
        className="w-full"
        onClick={() => {
          setError(null);
          start(async () => {
            const formData = new FormData();
            formData.set("code", code);
            const res = await joinLeague(formData);
            // Refresh rather than navigate: the URL is already correct, and the
            // page re-renders as a member this time.
            if (res.ok) {
              selectCompetition(res.id);
              router.refresh();
            } else setError(res.error);
          });
        }}
      >
        {pending ? "Joining…" : "Join this league"}
      </Button>
    </div>
  );
}

/** One click, no fields — spins up a private duel with a fresh AI opponent. */
export function StartAiDuelButton() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-3">
      {error ? <Alert>{error}</Alert> : null}
      <Button
        type="button"
        disabled={pending}
        className="w-full"
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await startAiDuel();
            if (res.ok) {
              selectCompetition(res.id);
              router.push(`/leagues/${res.code}`);
            } else setError(res.error);
          });
        }}
      >
        {pending ? "Starting…" : "1v1 the AI"}
      </Button>
    </div>
  );
}

export function JoinLeagueForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <form
      action={(formData) => {
        setError(null);
        start(async () => {
          const res = await joinLeague(formData);
          if (res.ok) {
            selectCompetition(res.id);
            router.push(`/leagues/${res.code}`);
          } else setError(res.error);
        });
      }}
      className="space-y-3"
    >
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <label htmlFor="league-code" className="mb-1.5 block text-sm font-medium">
          Invite code
        </label>
        <Input
          id="league-code"
          name="code"
          required
          minLength={4}
          maxLength={10}
          placeholder="K7QM2P"
          // Codes are uppercase; forcing it here avoids a confusing mismatch.
          className="uppercase tracking-widest"
        />
      </div>
      <Button type="submit" variant="secondary" disabled={pending} className="w-full">
        {pending ? "Joining…" : "Join league"}
      </Button>
    </form>
  );
}

/** A team code is its own passcode, separate from the league's — this lives
 *  on the leagues index page rather than inside /leagues/[code], because a
 *  caller who only has a team code does not yet know which league it
 *  belongs to; join_team_by_code resolves that. */
export function JoinTeamForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <form
      action={(formData) => {
        setError(null);
        start(async () => {
          const res = await joinTeam(formData);
          if (res.ok) {
            selectCompetition(res.id);
            router.push(`/leagues/${res.code}`);
          } else setError(res.error);
        });
      }}
      className="space-y-3"
    >
      {error ? <Alert>{error}</Alert> : null}
      <div>
        <label htmlFor="team-code" className="mb-1.5 block text-sm font-medium">
          Team code
        </label>
        <Input
          id="team-code"
          name="code"
          required
          minLength={4}
          maxLength={10}
          placeholder="K7QM2P"
          className="uppercase tracking-widest"
        />
      </div>
      <Button type="submit" variant="secondary" disabled={pending} className="w-full">
        {pending ? "Joining…" : "Join team"}
      </Button>
    </form>
  );
}

/** Adds a team to an already-created league — for a creator who forgot one
 *  at setup, or wants more later. RLS restricts who this actually works
 *  for; rendering it only for the creator (see the league page) just keeps
 *  it from being an obviously-dead-end control for anyone else. */
export function AddTeamForm({ leagueId, leagueCode }: { leagueId: string; leagueCode: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div className="space-y-2">
      {error ? <Alert>{error}</Alert> : null}
      <form
        ref={formRef}
        action={(formData) => {
          setError(null);
          start(async () => {
            const res = await createTeam(formData);
            if (res.ok) {
              formRef.current?.reset();
              // Same page, new data: refresh rather than navigate, so "Your
              // teams" picks up the one just added.
              router.refresh();
            } else {
              setError(res.error);
            }
          });
        }}
        className="flex gap-2"
      >
        <input type="hidden" name="leagueId" value={leagueId} />
        <input type="hidden" name="leagueCode" value={leagueCode} />
        <Input name="name" required maxLength={40} placeholder="Team name" className="flex-1" />
        <Button type="submit" variant="secondary" disabled={pending} className="shrink-0">
          {pending ? "Adding…" : "Add team"}
        </Button>
      </form>
    </div>
  );
}
