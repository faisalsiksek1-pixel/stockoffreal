import Link from "next/link";
import { redirect } from "next/navigation";

import { HoldingsTable } from "@/components/HoldingsTable";
import { PriceChart } from "@/components/PriceChart";
import { TradeList } from "@/components/TradeList";
import { Card, CardTitle } from "@/components/ui/Card";
import { Empty } from "@/components/ui/Empty";
import { PageHeading } from "@/components/ui/PageHeading";
import { Stat } from "@/components/ui/Stat";
import { money, moneyShort, percent } from "@/lib/format";
import { resolveCompetition } from "@/lib/competition";
import { fillDueOrders } from "@/lib/orders";
import { getMyPortfolio, getRecentTrades } from "@/lib/queries";
import { getEquityHistory } from "@/lib/snapshots";

export const metadata = { title: "Portfolio - StockOff" };
export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const resolved = await resolveCompetition();
  if (!resolved) redirect("/welcome");

  await fillDueOrders(resolved.leagueId);

  const portfolio = await getMyPortfolio(resolved.leagueId);
  if (!portfolio) redirect("/welcome");

  const [trades, equityHistory] = await Promise.all([
    getRecentTrades(portfolio.id, 100),
    getEquityHistory(portfolio.id),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        <PageHeading>Portfolio</PageHeading>
        <Link href="/share" className="text-sm font-medium text-ai hover:underline">
          Share result
        </Link>
      </div>

      <Card>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <Stat label="Total value" value={money(portfolio.totalValue)} large />
          <div className="flex gap-6">
            <Stat
              label="Total return"
              value={percent(portfolio.totalReturnPct)}
              tone={portfolio.totalReturnPct}
            />
            <Stat label="Cash" value={moneyShort(portfolio.cash)} />
          </div>
        </div>
        <div className="mt-4">
          <PriceChart history={equityHistory} height={160} />
        </div>
      </Card>

      <section>
        <CardTitle>Positions</CardTitle>
        {portfolio.holdings.length ? (
          <HoldingsTable holdings={portfolio.holdings} />
        ) : (
          <Empty title="No positions yet">
            <Link href="/trade" className="font-medium text-ai hover:underline">
              Place your first order
            </Link>
          </Empty>
        )}
      </section>

      <section>
        <CardTitle>All trades</CardTitle>
        {trades.length ? (
          <TradeList trades={trades} />
        ) : (
          <Empty title="No trades yet" />
        )}
      </section>
    </div>
  );
}
