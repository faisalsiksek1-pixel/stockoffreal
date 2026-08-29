import { createClient } from "@/lib/supabase/server";

/**
 * Real daily portfolio history. No cron — recorded as a side effect of
 * loading the dashboard, same "checked on your next visit" posture
 * fillDueOrders/checkRankChange already use elsewhere in this app.
 */

/** Upserts today's value for this portfolio — "today" by UTC day boundary,
 *  same convention lib/market/mock.ts's dayIndex() uses everywhere else in
 *  this app. Overwrites within the same day (keeps the latest value seen,
 *  not the first) so a day you check multiple times reflects your most
 *  recent look, not a stale first-visit number. */
export async function recordDailySnapshot(
  portfolioId: string,
  totalValue: number,
  totalReturnPct: number,
): Promise<void> {
  const supabase = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from("portfolio_snapshots").upsert(
    {
      portfolio_id: portfolioId,
      snapshot_date: today,
      total_value: totalValue,
      total_return_pct: totalReturnPct,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "portfolio_id,snapshot_date" },
  );
}

/** Oldest-first, mapped straight into PriceChart's PricePoint shape — a
 *  portfolio's value-over-time series needs nothing stock-specific from that
 *  component, so it's reused as-is rather than forked. */
export async function getEquityHistory(portfolioId: string): Promise<{ t: number; price: number }[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("portfolio_snapshots")
    .select("snapshot_date, total_value")
    .eq("portfolio_id", portfolioId)
    .order("snapshot_date", { ascending: true });

  return (data ?? []).map((r) => ({
    t: Math.floor(new Date(`${r.snapshot_date}T00:00:00Z`).getTime() / 86_400_000),
    price: Number(r.total_value),
  }));
}

/** Records today's value for a league's AI/Market competitor portfolio, via
 *  the SECURITY DEFINER function — the caller never owns that portfolio, so
 *  this can't go through a plain upsert like recordDailySnapshot does. */
export async function recordCompetitorSnapshot(
  portfolioId: string,
  totalValue: number,
  totalReturnPct: number,
): Promise<void> {
  const supabase = await createClient();
  await supabase.rpc("record_competitor_snapshot", {
    p_portfolio_id: portfolioId,
    p_total_value: totalValue,
    p_total_return_pct: totalReturnPct,
  });
}

/** Return-pct history for several portfolios in one query, grouped and
 *  sorted oldest-first per portfolio — what the race chart overlays. Percent
 *  (not dollar value) so AI/Market/You are directly comparable regardless of
 *  starting balance. */
export async function getReturnHistories(
  portfolioIds: string[],
): Promise<Map<string, { t: number; value: number }[]>> {
  const result = new Map<string, { t: number; value: number }[]>();
  if (portfolioIds.length === 0) return result;

  const supabase = await createClient();
  const { data } = await supabase
    .from("portfolio_snapshots")
    .select("portfolio_id, snapshot_date, total_return_pct")
    .in("portfolio_id", portfolioIds)
    .order("snapshot_date", { ascending: true });

  for (const r of data ?? []) {
    const point = {
      t: Math.floor(new Date(`${r.snapshot_date}T00:00:00Z`).getTime() / 86_400_000),
      value: Number(r.total_return_pct),
    };
    const list = result.get(r.portfolio_id) ?? [];
    list.push(point);
    result.set(r.portfolio_id, list);
  }
  return result;
}
