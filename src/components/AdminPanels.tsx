"use client";

import { useState, useTransition } from "react";

import {
  adminCreateSeason,
  adminEndSeason,
  adminRenameUser,
  adminResetBalances,
  adminTrade,
  type AdminResult,
} from "@/actions/admin";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

/** Shared submit wrapper so every panel reports success and failure the same way. */
function useAction() {
  const [result, setResult] = useState<AdminResult | null>(null);
  const [pending, start] = useTransition();

  function run(fn: () => Promise<AdminResult>) {
    setResult(null);
    start(async () => setResult(await fn()));
  }

  const banner = result ? (
    <Alert kind={result.ok ? "success" : "error"}>
      {result.ok ? result.message : result.error}
    </Alert>
  ) : null;

  return { run, pending, banner };
}

export function SpecialTradePanel() {
  const { run, pending, banner } = useAction();

  return (
    <Card>
      <CardTitle>Trade for the flagship AI</CardTitle>
      <form
        action={(fd) => run(() => adminTrade(fd))}
        className="space-y-3"
      >
        {banner}
        <Select name="side" dense defaultValue="buy">
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
          <option value="short">Short</option>
          <option value="cover">Cover</option>
        </Select>
        <div className="grid grid-cols-2 gap-2">
          <Input name="symbol" dense required placeholder="NVDA" className="uppercase" />
          <Input name="shares" dense type="number" step="any" min="0" required placeholder="Shares" />
        </div>
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Placing…" : "Place trade"}
        </Button>
      </form>
    </Card>
  );
}

export function SeasonPanel() {
  const { run, pending, banner } = useAction();

  return (
    <Card>
      <CardTitle>Seasons</CardTitle>
      <div className="space-y-3">
        {banner}
        <form action={(fd) => run(() => adminCreateSeason(fd))} className="space-y-2">
          <Input name="name" dense required placeholder="Season Two" />
          <Input name="slug" dense required placeholder="season-two" />
          <Button type="submit" disabled={pending} className="w-full">
            Create and activate
          </Button>
        </form>

        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => run(() => adminEndSeason())}
          >
            End current season
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={pending}
            onClick={() => {
              if (confirm("Delete all holdings and trades, and reset every balance?")) {
                run(() => adminResetBalances());
              }
            }}
          >
            Reset all balances
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function RenameUserPanel({
  users,
}: {
  users: { id: string; username: string }[];
}) {
  const { run, pending, banner } = useAction();

  return (
    <Card>
      <CardTitle>Rename a user</CardTitle>
      <form action={(fd) => run(() => adminRenameUser(fd))} className="space-y-3">
        {banner}
        <Select name="profileId" dense required defaultValue="">
          <option value="" disabled>
            Select a player…
          </option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </Select>
        <Input name="username" dense required placeholder="New username" />
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Saving…" : "Rename"}
        </Button>
        <p className="text-xs text-muted">
          For clearly inappropriate usernames. The leaderboard name updates too.
        </p>
      </form>
    </Card>
  );
}
