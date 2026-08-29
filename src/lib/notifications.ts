import { createClient, getCurrentUser } from "@/lib/supabase/server";

/**
 * In-app indicators, computed on page load — no push, no background job.
 * Same posture `fillDueOrders` (src/lib/orders.ts) already established for
 * limit orders: "checked on your next visit", recorded as a side effect of
 * loading the page where it's relevant, not on a timer.
 */

/** Unread chat count per league, for leagues the caller can actually read —
 *  a league they are not a member of simply contributes nothing, since the
 *  underlying RPC runs with the caller's own RLS applied. */
export async function getUnreadChatCounts(leagueIds: string[]): Promise<Map<string, number>> {
  if (leagueIds.length === 0) return new Map();

  const supabase = await createClient();
  const { data } = await supabase.rpc("unread_chat_counts", { p_league_ids: leagueIds });

  return new Map(
    ((data ?? []) as { league_id: string; unread_count: number | string }[]).map((row) => [
      row.league_id,
      Number(row.unread_count),
    ]),
  );
}

/** Marks a league's chat as read as of now. Called once, as a side effect of
 *  loading /leagues/[code] — the one place chat is actually visible. Only
 *  touches last_read_at: last_seen_rank is deliberately left out of the
 *  upsert payload so a conflict never overwrites it. */
export async function markChatRead(leagueId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;

  const supabase = await createClient();
  const now = new Date().toISOString();
  await supabase
    .from("league_visits")
    .upsert(
      { profile_id: user.id, league_id: leagueId, last_read_at: now, updated_at: now },
      { onConflict: "profile_id,league_id" },
    );
}

/**
 * What to show right now: currentRank vs. the rank last recorded for this
 * league. Returns null on a first-ever visit (nothing to compare against
 * yet) or when currentRank itself is null (no ranked position). Positive
 * means improved (moved to a lower/better rank number), negative means
 * dropped.
 *
 * Read-only — call recordRankSeen separately (typically via after(), so the
 * write doesn't block the response) to persist currentRank for next time.
 */
export async function getRankChange(leagueId: string, currentRank: number | null): Promise<number | null> {
  if (currentRank === null) return null;

  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data: visit } = await supabase
    .from("league_visits")
    .select("last_seen_rank")
    .eq("profile_id", user.id)
    .eq("league_id", leagueId)
    .maybeSingle();

  const previousRank = visit?.last_seen_rank ?? null;
  if (previousRank === null) return null;
  return previousRank - currentRank;
}

/** Records currentRank as "last seen", for the next visit's comparison via
 *  getRankChange. Its result is never displayed, so nothing should block
 *  the response on it — call via after(). */
export async function recordRankSeen(leagueId: string, currentRank: number | null): Promise<void> {
  if (currentRank === null) return;

  const user = await getCurrentUser();
  if (!user) return;

  const supabase = await createClient();
  await supabase
    .from("league_visits")
    .upsert(
      {
        profile_id: user.id,
        league_id: leagueId,
        last_seen_rank: currentRank,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "profile_id,league_id" },
    );
}
