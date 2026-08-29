import Link from "next/link";
import { redirect } from "next/navigation";

import { CompetitionSwitcher } from "@/components/CompetitionSwitcher";
import { CompetitorCard } from "@/components/CompetitorCard";
import { EquityRaceChart, type RaceSeries } from "@/components/EquityRaceChart";
import { HoldingsTable } from "@/components/HoldingsTable";
import { TradeList } from "@/components/TradeList";
import { Card, CardTitle } from "@/components/ui/Card";
import { Empty } from "@/components/ui/Empty";
import { Stat } from "@/components/ui/Stat";
import { resolveCompetition } from "@/lib/competition";
import { money, moneyShort, percent } from "@/lib/format";
import { checkRankChange } from "@/lib/notifications";
import { fillDueOrders } from "@/lib/orders";
import { getLeaderboard, getMyPortfolio, getRecentTrades, getSpecialCompetitors } from "@/lib/queries";
import { findRank } from "@/lib/portfolio";
import { getReturnHistories, recordCompetitorSnapshot, recordDailySnapshot } from "@/lib/snapshots";

export const metadata = { title: "Dashboard - StockOff" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const resolved = await resolveCompetition();
  if (!resolved) redirect("/welcome");
  const { leagueId, competitions } = resolved;

  // Any limit order that has crossed its target fills here too, not just on
  // the trade page — this is the only "background" checking these get.
  await fillDueOrders(leagueId);

  const portfolio = await getMyPortfolio(leagueId);
  if (!portfolio) redirect("/welcome");

  // Real daily history, not the trade-log reconstruction the portfolio page
  // used to show — recorded here the same "checked on your next visit" way
  // rank changes and due orders already are.
  await recordDailySnapshot(portfolio.id, portfolio.totalValue, portfolio.totalReturnPct);

  // Fetched together: the dashboard is the one page that needs everything, and
  // these are independent queries.
  const [competitors, rows, trades] = await Promise.all([
    getSpecialCompetitors(leagueId),
    getLeaderboard(leagueId),
    getRecentTrades(portfolio.id, 8),
  ]);

  // Same "checked on your next visit" recording as the viewer's own
  // portfolio above, just on the caller's behalf — AI/Market have no owning
  // user to log the visit as (see 0014_competitor_snapshots.sql).
  await Promise.all(
    competitors.map((c) => recordCompetitorSnapshot(c.id, c.totalValue, c.totalReturnPct)),
  );
  const raceHistory = await getReturnHistories([portfolio.id, ...competitors.map((c) => c.id)]);
  const raceSeries: RaceSeries[] = [portfolio, ...competitors].map((p) => ({
    id: p.id,
    ownerType: p.ownerType,
    displayName: p.displayName,
    history: raceHistory.get(p.id) ?? [],
  }));

  const rank = findRank(rows, portfolio.id);
  const current = competitions.find((c) => c.id === leagueId);

  // Compares against (and then records) the rank last seen on this dashboard
  // — a lightweight "you moved since last visit" indicator, no push/cron.
  const rankDelta = await checkRankChange(leagueId, rank);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="text-2xs font-semibold uppercase tracking-widest text-muted">
            Portfolio value
          </div>
          <CompetitionSwitcher competitions={competitions} currentId={leagueId} />
        </div>
        {current && competitions.length > 1 ? (
          <div className="mt-0.5 text-xs text-muted">{current.name}</div>
        ) : null}
        <div className="tnum mt-1 text-4xl font-extrabold tracking-tight sm:text-5xl">
          {money(portfolio.totalValue)}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          <span className="tnum">
            <span className="text-muted">Today </span>
            <span className={portfolio.dayChangePct >= 0 ? "text-up" : "text-down"}>
              {percent(portfolio.dayChangePct)}
            </span>
          </span>
          <span className="tnum">
            <span className="text-muted">Total </span>
            <span className={portfolio.totalReturnPct >= 0 ? "text-up" : "text-down"}>
              {percent(portfolio.totalReturnPct)} ({money(portfolio.totalReturn, 0)})
            </span>
          </span>
        </div>

        {rankDelta ? (
          <div className="tnum mt-2 text-xs">
            <span className={rankDelta > 0 ? "text-up" : "text-down"}>
              {rankDelta > 0 ? `↑ Up ${rankDelta}` : `↓ Down ${Math.abs(rankDelta)}`}
            </span>{" "}
            <span className="text-muted">since your last visit</span>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href="/trade"
            className="rounded-xl bg-ai px-5 py-2.5 text-sm font-semibold text-on-accent transition hover:opacity-90"
          >
            Trade
          </Link>
          <Link
            href={current?.is_public ? "/leaderboard" : `/leagues/${current?.code ?? ""}`}
            className="rounded-xl border border-line px-5 py-2.5 text-sm font-semibold transition hover:border-muted"
          >
            View leaderboard
          </Link>
          <Link
            href="/leagues"
            className="rounded-xl border border-line px-5 py-2.5 text-sm font-semibold transition hover:border-muted"
          >
            Challenge friends
          </Link>
          <Link
            href="/news"
            className="rounded-xl border border-line px-5 py-2.5 text-sm font-semibold transition hover:border-muted"
          >
            News
          </Link>
        </div>
      </section>

      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Cash" value={moneyShort(portfolio.cash)} />
          <Stat label="Invested" value={moneyShort(portfolio.holdingsValue)} />
          <Stat
            label="Total return"
            value={percent(portfolio.totalReturnPct)}
            tone={portfolio.totalReturnPct}
          />
          <Stat
            label="League rank"
            value={rank ? `#${rank}` : "-"}
            sub={rows.length ? `of ${rows.length}` : undefined}
          />
        </div>
      </Card>

      {competitors.length > 0 ? (
        <section>
          <CardTitle>The race</CardTitle>
          <Card>
            <EquityRaceChart series={raceSeries} />
          </Card>
          <div
            className={`mt-3 grid grid-cols-1 gap-3 ${competitors.length >= 2 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
          >
            <CompetitorCard portfolio={portfolio} />
            {competitors.map((c) => (
              <CompetitorCard key={c.id} portfolio={c} />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <CardTitle>Your holdings</CardTitle>
        {portfolio.holdings.length ? (
          <HoldingsTable holdings={portfolio.holdings} />
        ) : (
          <Empty title="No positions yet">
            <Link href="/trade" className="font-medium text-ai hover:underline">
              Buy your first stock
            </Link>{" "}
            to get on the board.
          </Empty>
        )}
      </section>

      <section>
        <CardTitle>Recent trades</CardTitle>
        {trades.length ? (
          <TradeList trades={trades} />
        ) : (
          <Empty title="No trades yet">Your order history will appear here.</Empty>
        )}
      </section>
    </div>
  );
}
