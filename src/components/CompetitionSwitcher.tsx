"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Select } from "@/components/ui/Select";
import { COMPETITION_COOKIE, type Competition } from "@/lib/types";

/**
 * Written directly as a client-side cookie, not through a server action: it
 * is a plain view preference, not sensitive, so a round trip to set it would
 * only add latency. `router.refresh()` re-renders the current server page,
 * which reads the new value back via `resolveCompetition` in
 * `src/lib/competition.ts`.
 */
export function CompetitionSwitcher({
  competitions,
  currentId,
}: {
  competitions: Competition[];
  currentId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (competitions.length < 2) return null;

  return (
    <Select
      dense
      value={currentId}
      disabled={pending}
      onChange={(e) => {
        const leagueId = e.target.value;
        document.cookie = `${COMPETITION_COOKIE}=${leagueId}; path=/; max-age=31536000; samesite=lax`;
        startTransition(() => router.refresh());
      }}
      aria-label="Switch competition"
      className="w-auto font-semibold disabled:opacity-60"
    >
      {competitions.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}
