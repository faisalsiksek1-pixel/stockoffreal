import { redirect } from "next/navigation";

import { PendingOrders } from "@/components/PendingOrders";
import { TradePanel } from "@/components/TradePanel";
import { PageHeading } from "@/components/ui/PageHeading";
import { resolveCompetition } from "@/lib/competition";
import { INSTRUMENTS } from "@/lib/market";
import { money } from "@/lib/format";
import { fillDueOrders } from "@/lib/orders";
import { getMyPortfolio, getPendingOrders } from "@/lib/queries";

export const metadata = { title: "Trade - StockOff" };
export const dynamic = "force-dynamic";

export default async function TradePage() {
  const resolved = await resolveCompetition();
  if (!resolved) redirect("/welcome");

  // Before reading the portfolio, so a limit order that just crossed its
  // target shows up already filled rather than still pending.
  await fillDueOrders(resolved.leagueId);

  const portfolio = await getMyPortfolio(resolved.leagueId);
  if (!portfolio) redirect("/welcome");

  const pendingOrders = await getPendingOrders(portfolio.id);

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <PageHeading>Trade</PageHeading>
        <span className="tnum text-sm text-muted">{money(portfolio.cash)} cash</span>
      </div>

      <TradePanel
        cash={portfolio.cash}
        availableCash={portfolio.availableCash}
        holdings={portfolio.holdings.map((h) => ({
          symbol: h.symbol,
          shares: h.shares,
          avgCost: h.avgCost,
        }))}
        instruments={INSTRUMENTS}
      />

      <PendingOrders orders={pendingOrders} />

      <p className="text-xs leading-relaxed text-muted">
        Orders fill at the latest simulated price. Short selling is supported
        with 1:1 cash collateral, and buys/shorts can use up to 20x leveraged
        buying power. Limit orders fill automatically once their target price is
        crossed, checked whenever you're next on StockOff. There is no
        live market feed, so a fill can lag your actual next visit.
      </p>
    </div>
  );
}
