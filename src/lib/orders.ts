import { marketData } from "@/lib/market";
import { shortLiability } from "@/lib/portfolio";
import { resolveOrder } from "@/lib/trade-rules";
import { createClient } from "@/lib/supabase/server";
import type { TradeSide } from "@/lib/types";

/**
 * Fills whichever of the caller's pending limit orders have crossed their
 * target price, against today's simulated quotes.
 *
 * There is no cron here (see 0007_pending_orders.sql's header) — this is
 * called at the top of every page that loads the signed-in caller's own
 * portfolio (dashboard, portfolio, trade), so "auto" means "checked on your
 * next page view", not "checked continuously". A crossed order can sit
 * unfilled between visits; nothing else in this app updates in the
 * background either.
 *
 * cash/availableCash/liability are snapshotted once, before any fills in
 * this pass. If an earlier order in the loop fills and changes what a later
 * one can afford, the later one is checked against a now-stale snapshot —
 * but that only ever costs a fill being one page view late: the real
 * decision happens inside fill_pending_order → execute_trade, which takes
 * its own row lock and re-reads live cash, so nothing can be double-spent.
 */
export async function fillDueOrders(leagueId: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: portfolio } = await supabase
    .from("portfolios")
    .select("id, cash")
    .eq("profile_id", user.id)
    .eq("league_id", leagueId)
    .maybeSingle();
  if (!portfolio) return;

  const { data: orders } = await supabase
    .from("pending_orders")
    .select("id, symbol, side, mode, quantity, target_price")
    .eq("portfolio_id", portfolio.id);
  if (!orders?.length) return;

  const { data: holdingRows } = await supabase
    .from("holdings")
    .select("symbol, shares, avg_cost")
    .eq("portfolio_id", portfolio.id);

  const holdings = (holdingRows ?? []).map((h) => ({
    symbol: h.symbol as string,
    shares: Number(h.shares),
    avgCost: Number(h.avg_cost),
  }));
  const cash = Number(portfolio.cash);
  const liability = shortLiability(holdings);
  const availableCash = cash - liability;

  const symbols = [...new Set(orders.map((o) => o.symbol as string))];
  const quotes = await marketData().getQuotes(symbols);

  for (const o of orders) {
    const quote = quotes.get(o.symbol as string);
    if (!quote) continue;

    const side = o.side as TradeSide;
    const target = Number(o.target_price);
    const crossed = side === "buy" ? quote.price <= target : quote.price >= target;
    if (!crossed) continue;

    const mode = o.mode as "shares" | "dollars";
    const quantity = Number(o.quantity);
    const held = holdings.find((h) => h.symbol === o.symbol);

    const check = resolveOrder(
      {
        symbol: o.symbol as string,
        side,
        ...(mode === "shares" ? { shares: quantity } : { dollars: quantity }),
      },
      quote.price,
      cash,
      availableCash,
      liability,
      held,
    );
    // Not affordable right now (or no longer holds enough to sell) — leave
    // it pending, retried on the next page view.
    if (!check.ok) continue;

    // Errors here are expected sometimes (another request already filled or
    // cancelled this order, or the snapshot above went stale) and are not
    // worth surfacing — the order simply stays pending and is retried.
    await supabase.rpc("fill_pending_order", {
      p_order_id: o.id,
      p_price: quote.price,
      p_shares: check.shares,
    });
  }
}
