import { cookies } from "next/headers";

import { getMyCompetitions } from "./queries";
import { COMPETITION_COOKIE, type Competition } from "./types";

/**
 * Resolves "the competition the caller is currently viewing" for pages that
 * show a single portfolio (dashboard, portfolio, trade, profile, share).
 *
 * Reads the last competition picked via the dashboard switcher from a cookie
 * rather than a URL param — a plain preference, not shareable/bookmarkable
 * state, so it does not need to be threaded through every internal link.
 * Falls back to the flagship (first in `getMyCompetitions()`'s order) if the
 * cookie is unset or points at a competition the caller is no longer in.
 *
 * Returns null only if the caller has no competitions at all, which should
 * not happen for a real signed-in user — every signup gets the flagship.
 */
export async function resolveCompetition(): Promise<{
  leagueId: string;
  competitions: Competition[];
} | null> {
  const competitions = await getMyCompetitions();
  if (!competitions.length) return null;

  const jar = await cookies();
  const requested = jar.get(COMPETITION_COOKIE)?.value;
  const match = requested && competitions.find((c) => c.id === requested);

  return { leagueId: (match || competitions[0])!.id, competitions };
}
