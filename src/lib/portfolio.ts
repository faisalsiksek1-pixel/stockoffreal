import type {
  Holding,
  LeaderboardRow,
  OwnerType,
  Quote,
  TeamStanding,
  ValuedHolding,
  ValuedPortfolio,
} from "./types";

/**
 * Portfolio valuation and leaderboard ranking.
 *
 * Deliberately pure: no database, no network, no framework. Every competitor —
 * users, the AI, the Human, the benchmark — is valued by these same functions,
 * which is what makes the comparison meaningful. It also means the money maths
 * is unit-testable without standing up Supabase.
 */

export interface PortfolioInput {
  id: string;
  ownerType: OwnerType;
  displayName: string;
  cash: number;
  startingBalance: number;
  holdings: Holding[];
}

/** Round to cents. Avoids 0.30000000000000004 leaking into displayed money. */
export function toCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function valueHolding(
  holding: Holding,
  quote: Quote | undefined,
  portfolioTotal: number,
): ValuedHolding {
  // An unpriced symbol falls back to average cost rather than zero: showing a
  // position as a total loss because a quote failed to load would be wrong and
  // alarming.
  const price = quote?.price ?? holding.avgCost;
  const prevClose = quote?.prevClose ?? price;
  const marketValue = toCents(holding.shares * price);
  const costBasis = toCents(holding.shares * holding.avgCost);
  // Sign-correct for shorts too: with negative shares, a rising price makes
  // marketValue fall below costBasis, correctly registering as a loss.
  const pnl = toCents(marketValue - costBasis);

  return {
    ...holding,
    name: quote?.name ?? holding.symbol,
    price,
    marketValue,
    costBasis,
    pnl,
    pnlPct: costBasis === 0 ? 0 : pnl / costBasis,
    weight: portfolioTotal === 0 ? 0 : marketValue / portfolioTotal,
    dayChangePct: prevClose === 0 ? 0 : (price - prevClose) / prevClose,
    isShort: holding.shares < 0,
  };
}

/**
 * Cash locked up backing open short positions, valued at each short's own
 * cost basis — the same 1:1 collateral rule `execute_trade` enforces live
 * from `holdings`. Not persisted anywhere, so it can never drift; recomputed
 * on every read.
 */
export function shortLiability(holdings: Holding[]): number {
  return toCents(
    holdings
      .filter((h) => h.shares < 0)
      .reduce((sum, h) => sum - h.shares * h.avgCost, 0),
  );
}

export function valuePortfolio(
  input: PortfolioInput,
  quotes: Map<string, Quote>,
): ValuedPortfolio {
  const holdingsValue = toCents(
    input.holdings.reduce((sum, h) => {
      const price = quotes.get(h.symbol)?.price ?? h.avgCost;
      return sum + h.shares * price;
    }, 0),
  );
  const totalValue = toCents(input.cash + holdingsValue);

  // Day change is measured on the whole account, not just the equity sleeve:
  // cash does not move, so a portfolio that is half cash correctly shows a
  // smaller daily swing than one that is fully invested.
  const prevValue = toCents(
    input.cash +
      input.holdings.reduce((sum, h) => {
        const q = quotes.get(h.symbol);
        return sum + h.shares * (q?.prevClose ?? q?.price ?? h.avgCost);
      }, 0),
  );

  const totalReturn = toCents(totalValue - input.startingBalance);

  return {
    id: input.id,
    ownerType: input.ownerType,
    displayName: input.displayName,
    cash: toCents(input.cash),
    availableCash: toCents(input.cash - shortLiability(input.holdings)),
    startingBalance: input.startingBalance,
    holdingsValue,
    totalValue,
    totalReturn,
    totalReturnPct:
      input.startingBalance === 0 ? 0 : totalReturn / input.startingBalance,
    dayChangePct: prevValue === 0 ? 0 : (totalValue - prevValue) / prevValue,
    holdings: input.holdings
      .map((h) => valueHolding(h, quotes.get(h.symbol), totalValue))
      .sort((a, b) => b.marketValue - a.marketValue),
  };
}

/**
 * Rank by percentage return, not dollar value.
 *
 * Everyone starts at the same balance so the two orderings agree today — but
 * ranking on percentage keeps the board fair if a season ever starts players at
 * different amounts, and it is the comparison the benchmark makes sense against.
 */
export function rankPortfolios(portfolios: ValuedPortfolio[]): LeaderboardRow[] {
  return [...portfolios]
    .sort((a, b) => {
      if (b.totalReturnPct !== a.totalReturnPct) {
        return b.totalReturnPct - a.totalReturnPct;
      }
      // Stable, predictable tiebreak so ranks do not shuffle between renders.
      return a.displayName.localeCompare(b.displayName);
    })
    .map((p, i) => ({
      rank: i + 1,
      portfolioId: p.id,
      ownerType: p.ownerType,
      displayName: p.displayName,
      totalValue: p.totalValue,
      totalReturnPct: p.totalReturnPct,
      dayChangePct: p.dayChangePct,
    }));
}

/**
 * Team-vs-team standings: average percentage return across each team's
 * members. Same tiebreak convention as rankPortfolios (name, ascending) so
 * both boards read consistently. Rows with no team (ungrouped players, or
 * the AI/benchmark competitors, which never have a team) are excluded
 * rather than forming a team of their own.
 */
export function rankTeams(
  rows: { teamId?: string | null; teamName?: string | null; totalReturnPct: number }[],
): TeamStanding[] {
  const groups = new Map<string, { teamName: string; sum: number; count: number }>();
  for (const r of rows) {
    if (!r.teamId || !r.teamName) continue;
    const g = groups.get(r.teamId);
    if (g) {
      g.sum += r.totalReturnPct;
      g.count += 1;
    } else {
      groups.set(r.teamId, { teamName: r.teamName, sum: r.totalReturnPct, count: 1 });
    }
  }
  return [...groups.entries()]
    .map(([teamId, g]) => ({
      teamId,
      teamName: g.teamName,
      memberCount: g.count,
      avgReturnPct: g.sum / g.count,
    }))
    .sort((a, b) => b.avgReturnPct - a.avgReturnPct || a.teamName.localeCompare(b.teamName))
    .map((t, i) => ({ rank: i + 1, ...t }));
}

export function findRank(rows: LeaderboardRow[], portfolioId: string): number | null {
  return rows.find((r) => r.portfolioId === portfolioId)?.rank ?? null;
}
