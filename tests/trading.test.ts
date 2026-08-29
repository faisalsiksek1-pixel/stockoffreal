import { describe, expect, it } from "vitest";

import {
  rankPortfolios,
  rankTeams,
  shortLiability,
  toCents,
  valuePortfolio,
  type PortfolioInput,
} from "@/lib/portfolio";
import { DEFAULT_LEVERAGE, newAverageCost, resolveOrder } from "@/lib/trade-rules";
import type { Holding, Quote } from "@/lib/types";

/**
 * Tests for the money logic.
 *
 * These cover the rules that must never be wrong: starting balance, order
 * costing, the two ways a user could cheat (overspending and overselling),
 * position maths and ranking. All pure — no database, no network.
 *
 * The concurrency guarantee (two simultaneous trades cannot overspend the same
 * balance) lives in the execute_trade SQL function's row lock and cannot be
 * exercised here; see the README limitations.
 */

const STARTING = 100_000;

function quote(symbol: string, price: number, prevClose = price): Quote {
  return { symbol, name: `${symbol} Inc.`, price, prevClose };
}

function portfolio(over: Partial<PortfolioInput> = {}): PortfolioInput {
  return {
    id: "p1",
    ownerType: "user",
    displayName: "tester",
    cash: STARTING,
    startingBalance: STARTING,
    holdings: [],
    ...over,
  };
}

describe("new account", () => {
  it("starts with exactly $100,000 and zero return", () => {
    const valued = valuePortfolio(portfolio(), new Map());

    expect(valued.cash).toBe(100_000);
    expect(valued.totalValue).toBe(100_000);
    expect(valued.holdingsValue).toBe(0);
    expect(valued.totalReturn).toBe(0);
    expect(valued.totalReturnPct).toBe(0);
    expect(valued.holdings).toHaveLength(0);
  });
});

describe("buy orders", () => {
  it("costs shares x price", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 10 },
      200,
      STARTING,
      STARTING,
      0,
      undefined,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shares).toBe(10);
    expect(result.amount).toBe(2000);
  });

  it("converts a dollar amount into fractional shares, rounding down", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", dollars: 1000 },
      300,
      STARTING,
      STARTING,
      0,
      undefined,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Rounded down so the order never costs more than the dollars requested.
    expect(result.shares).toBeCloseTo(3.333333, 5);
    expect(result.amount).toBeLessThanOrEqual(1000);
  });

  it("allows spending the entire balance to the cent", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 1000 },
      100,
      100_000,
      100_000,
      0,
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an order that costs more than leveraged buying power", () => {
    // availableCash is $100,000; at the default leverage (2x) buying power is
    // $200,000, so this $200,200 order must still be rejected.
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 1001 },
      200,
      100_000,
      100_000,
      0,
      undefined,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not enough buying power/i);
  });

  it("allows a leveraged buy beyond raw cash, up to the default leverage x availableCash", () => {
    // $100,000 available, default leverage 2x → $200,000 buying power.
    // $199,900 (999 shares) fits; $200,000 exactly (1000 shares) also fits.
    const withinLeverage = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 1000 },
      200, // $200,000, exactly the default leverage x availableCash
      100_000,
      100_000,
      0,
      undefined,
    );
    expect(withinLeverage.ok).toBe(true);
    expect(DEFAULT_LEVERAGE).toBe(2);
  });

  it("rejects a leverage that is not one of the offered options", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 1 },
      200,
      100_000,
      100_000,
      0,
      undefined,
      3,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/leverage/i);
  });

  it("scales buying power with a higher chosen leverage", () => {
    // $100,000 available, 10x → $1,000,000 buying power. 5,000 shares @ $200
    // is $1,000,000 exactly.
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 5000 },
      200,
      100_000,
      100_000,
      0,
      undefined,
      10,
    );
    expect(result.ok).toBe(true);

    const overLimit = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 5001 },
      200,
      100_000,
      100_000,
      0,
      undefined,
      10,
    );
    expect(overLimit.ok).toBe(false);
  });

  it("allows choosing 1x to opt out of leverage entirely", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 501 },
      200, // $100,200 — one dollar over raw cash
      100_000,
      100_000,
      0,
      undefined,
      1,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a buy with no cash at all", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", dollars: 100 },
      50,
      0,
      0,
      0,
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects zero, negative and non-numeric quantities", () => {
    for (const shares of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveOrder(
          { symbol: "AAPL", side: "buy", shares },
          100,
          STARTING,
          STARTING,
          0,
          undefined,
        ).ok,
      ).toBe(false);
    }
  });

  it("refuses to price an order when there is no valid price", () => {
    expect(
      resolveOrder(
        { symbol: "ZZZZ", side: "buy", shares: 1 },
        0,
        STARTING,
        STARTING,
        0,
        undefined,
      ).ok,
    ).toBe(false);
  });

  it("rejects a buy while the symbol is currently short", () => {
    const short: Holding = { symbol: "AAPL", shares: -10, avgCost: 150 };
    const result = resolveOrder(
      { symbol: "AAPL", side: "buy", shares: 1 },
      150,
      STARTING,
      STARTING,
      1500,
      short,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/short/i);
  });
});

describe("sell orders", () => {
  const held: Holding = { symbol: "AAPL", shares: 10, avgCost: 150 };

  it("credits shares x price", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "sell", shares: 4 },
      200,
      0,
      0,
      0,
      held,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toBe(800);
  });

  it("allows selling the whole position", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "sell", shares: 10 },
      200,
      0,
      0,
      0,
      held,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects selling more shares than owned", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "sell", shares: 11 },
      200,
      0,
      0,
      0,
      held,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/only own/i);
  });

  it("rejects selling a stock that is not held", () => {
    const result = resolveOrder(
      { symbol: "TSLA", side: "sell", shares: 1 },
      200,
      0,
      0,
      0,
      undefined,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/do not own/i);
  });

  it("does not allow a sell to be funded by cash it does not have", () => {
    // A sell must be bounded by the position, never by the cash balance.
    const result = resolveOrder(
      { symbol: "AAPL", side: "sell", shares: 50 },
      200,
      1_000_000,
      1_000_000,
      0,
      held,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a sell while the symbol is currently short", () => {
    const short: Holding = { symbol: "AAPL", shares: -10, avgCost: 150 };
    const result = resolveOrder(
      { symbol: "AAPL", side: "sell", shares: 1 },
      150,
      0,
      0,
      1500,
      short,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/cover/i);
  });
});

describe("short orders", () => {
  it("opens a short and credits proceeds like a sell", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "short", shares: 10 },
      200,
      STARTING,
      STARTING,
      0,
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toBe(2000);
  });

  it("adds to an existing short", () => {
    // Cash already reflects the first short's proceeds (100,000 + 1,500);
    // availableCash (cash - liability) is back to the original 100,000, and
    // shortCapacity (availableCash - liability) is what actually gates this.
    const short: Holding = { symbol: "AAPL", shares: -10, avgCost: 150 };
    const result = resolveOrder(
      { symbol: "AAPL", side: "short", shares: 5 },
      200,
      STARTING + 1500,
      STARTING,
      1500,
      short,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects shorting a symbol currently held long", () => {
    const long: Holding = { symbol: "AAPL", shares: 10, avgCost: 150 };
    const result = resolveOrder(
      { symbol: "AAPL", side: "short", shares: 1 },
      200,
      STARTING,
      STARTING,
      0,
      long,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/long/i);
  });

  it("rejects a short beyond capacity even though availableCash alone would allow it", () => {
    // Regression for a real bug caught while writing this test: cash and
    // liability both rise by the same amount when a short opens, so
    // availableCash (cash - liability) never moves from shorting — checking
    // a new short against availableCash directly would only ever bound a
    // single trade's size, never the running total, letting unlimited small
    // shorts through. shortCapacity (availableCash - liability again) is
    // what must gate this: here availableCash is 100,000 (would wrongly
    // allow a much larger short), but shortCapacity is only 40,000 — 80,000
    // at LEVERAGE (2x).
    const result = resolveOrder(
      { symbol: "MSFT", side: "short", shares: 401 },
      200, // $80,200
      160_000,
      100_000,
      60_000,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not enough buying power to short/i);

    // Exactly at the true (leveraged) limit succeeds.
    const atLimit = resolveOrder(
      { symbol: "MSFT", side: "short", shares: 400 },
      200, // $80,000 = shortCapacity (40,000) x LEVERAGE (2x)
      160_000,
      100_000,
      60_000,
      undefined,
    );
    expect(atLimit.ok).toBe(true);
  });
});

describe("cover orders", () => {
  const short: Holding = { symbol: "AAPL", shares: -10, avgCost: 150 };

  it("costs shares x current price, buying back the short", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "cover", shares: 4 },
      120,
      STARTING,
      STARTING,
      1500,
      short,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amount).toBe(480);
  });

  it("allows covering the whole position", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "cover", shares: 10 },
      120,
      STARTING,
      STARTING,
      1500,
      short,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects covering more shares than are short", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "cover", shares: 11 },
      120,
      STARTING,
      STARTING,
      1500,
      short,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/only short/i);
  });

  it("rejects covering a symbol that is not short", () => {
    const result = resolveOrder(
      { symbol: "TSLA", side: "cover", shares: 1 },
      120,
      STARTING,
      STARTING,
      0,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not short/i);
  });

  it("rejects a cover that costs more cash than is on hand", () => {
    const result = resolveOrder(
      { symbol: "AAPL", side: "cover", shares: 10 },
      120,
      100, // price rose against the short; buying back costs more than this
      100,
      1500,
      short,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not enough cash/i);
  });
});

describe("shortLiability", () => {
  it("sums the cost-basis value of every short position, ignoring longs", () => {
    const liability = shortLiability([
      { symbol: "AAPL", shares: -10, avgCost: 150 },
      { symbol: "MSFT", shares: 5, avgCost: 300 },
      { symbol: "TSLA", shares: -2, avgCost: 250 },
    ]);
    expect(liability).toBe(2000); // 10*150 + 2*250, MSFT excluded
  });

  it("is zero with no short positions", () => {
    expect(shortLiability([{ symbol: "AAPL", shares: 10, avgCost: 150 }])).toBe(0);
  });
});

describe("average cost", () => {
  it("is the price paid on a first purchase", () => {
    expect(newAverageCost(undefined, 10, 150)).toBe(150);
  });

  it("is share-weighted when adding to a position", () => {
    // 10 @ 100 then 10 @ 200 → 150.
    expect(newAverageCost({ symbol: "A", shares: 10, avgCost: 100 }, 10, 200)).toBe(150);
    // 30 @ 100 then 10 @ 200 → 125.
    expect(newAverageCost({ symbol: "A", shares: 30, avgCost: 100 }, 10, 200)).toBe(125);
  });
});

describe("holdings and returns", () => {
  it("values positions and computes profit and loss", () => {
    const valued = valuePortfolio(
      portfolio({
        cash: 50_000,
        holdings: [
          { symbol: "AAPL", shares: 100, avgCost: 200 },
          { symbol: "MSFT", shares: 50, avgCost: 400 },
        ],
      }),
      new Map([
        ["AAPL", quote("AAPL", 250)],
        ["MSFT", quote("MSFT", 380)],
      ]),
    );

    // 100 x 250 = 25,000 and 50 x 380 = 19,000.
    expect(valued.holdingsValue).toBe(44_000);
    expect(valued.totalValue).toBe(94_000);
    expect(valued.totalReturn).toBe(-6_000);
    expect(valued.totalReturnPct).toBeCloseTo(-0.06, 10);

    const aapl = valued.holdings.find((h) => h.symbol === "AAPL")!;
    expect(aapl.pnl).toBe(5_000);
    expect(aapl.pnlPct).toBeCloseTo(0.25, 10);

    const msft = valued.holdings.find((h) => h.symbol === "MSFT")!;
    expect(msft.pnl).toBe(-1_000);
    expect(msft.pnlPct).toBeCloseTo(-0.05, 10);
  });

  it("weights positions against total value, summing to the invested share", () => {
    const valued = valuePortfolio(
      portfolio({
        cash: 0,
        holdings: [
          { symbol: "AAPL", shares: 100, avgCost: 100 },
          { symbol: "MSFT", shares: 100, avgCost: 100 },
        ],
      }),
      new Map([
        ["AAPL", quote("AAPL", 300)],
        ["MSFT", quote("MSFT", 100)],
      ]),
    );

    const aapl = valued.holdings.find((h) => h.symbol === "AAPL")!;
    expect(aapl.weight).toBeCloseTo(0.75, 10);
    expect(valued.holdings.reduce((s, h) => s + h.weight, 0)).toBeCloseTo(1, 10);
  });

  it("sorts holdings by market value, largest first", () => {
    const valued = valuePortfolio(
      portfolio({
        holdings: [
          { symbol: "SMALL", shares: 1, avgCost: 10 },
          { symbol: "BIG", shares: 100, avgCost: 10 },
        ],
      }),
      new Map([
        ["SMALL", quote("SMALL", 10)],
        ["BIG", quote("BIG", 10)],
      ]),
    );
    expect(valued.holdings[0]!.symbol).toBe("BIG");
  });

  it("falls back to average cost when a quote is missing, not to zero", () => {
    // A failed quote must not make a position look like a total loss.
    const valued = valuePortfolio(
      portfolio({ cash: 0, holdings: [{ symbol: "AAPL", shares: 10, avgCost: 100 }] }),
      new Map(),
    );
    expect(valued.totalValue).toBe(1_000);
    expect(valued.holdings[0]!.pnl).toBe(0);
  });

  it("measures the day change across the whole account, cash included", () => {
    // Half cash, and the held stock rose 10% → the account moves ~5%.
    const valued = valuePortfolio(
      portfolio({ cash: 50_000, holdings: [{ symbol: "AAPL", shares: 500, avgCost: 100 }] }),
      new Map([["AAPL", quote("AAPL", 110, 100)]]),
    );
    expect(valued.dayChangePct).toBeCloseTo(0.05, 4);
  });

  it("values a short position as a liability, correctly signed as price moves", () => {
    // Shorted 10 @ 150; price rises to 180 → a loss, and total value falls by
    // the same amount cash rose when the short was opened.
    const valued = valuePortfolio(
      portfolio({ cash: 101_500, holdings: [{ symbol: "AAPL", shares: -10, avgCost: 150 }] }),
      new Map([["AAPL", quote("AAPL", 180)]]),
    );
    const aapl = valued.holdings[0]!;
    expect(aapl.isShort).toBe(true);
    expect(aapl.marketValue).toBe(-1800);
    expect(aapl.pnl).toBe(-300); // (150-180) * 10
    expect(valued.totalValue).toBe(99_700); // 101,500 - 1,800
    expect(valued.availableCash).toBe(100_000); // 101,500 - short liability of 1,500
  });
});

describe("leaderboard ranking", () => {
  const make = (id: string, name: string, value: number, owner: PortfolioInput["ownerType"] = "user") =>
    valuePortfolio(
      { id, ownerType: owner, displayName: name, cash: value, startingBalance: STARTING, holdings: [] },
      new Map(),
    );

  it("ranks by percentage return, best first", () => {
    const rows = rankPortfolios([
      make("a", "loser", 90_000),
      make("c", "winner", 120_000),
      make("b", "flat", 100_000),
    ]);

    expect(rows.map((r) => r.displayName)).toEqual(["winner", "flat", "loser"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(rows[0]!.totalReturnPct).toBeCloseTo(0.2, 10);
  });

  it("includes the special competitors alongside players", () => {
    const rows = rankPortfolios([
      make("u", "player", 105_000),
      make("ai", "StockOff AI", 110_000, "ai"),
      make("h", "The Human", 101_000, "human"),
      make("m", "S&P 500", 103_000, "benchmark"),
    ]);

    expect(rows[0]!.ownerType).toBe("ai");
    expect(rows.map((r) => r.ownerType)).toContain("benchmark");
    expect(rows).toHaveLength(4);
  });

  it("breaks ties by name so ranks are stable between renders", () => {
    const first = rankPortfolios([make("b", "bravo", 100_000), make("a", "alpha", 100_000)]);
    const second = rankPortfolios([make("a", "alpha", 100_000), make("b", "bravo", 100_000)]);
    expect(first.map((r) => r.displayName)).toEqual(second.map((r) => r.displayName));
    expect(first[0]!.displayName).toBe("alpha");
  });

  it("returns an empty board rather than throwing when there are no players", () => {
    expect(rankPortfolios([])).toEqual([]);
  });
});

describe("rankTeams", () => {
  it("averages totalReturnPct across a team's members", () => {
    const standings = rankTeams([
      { teamId: "t1", teamName: "Red", totalReturnPct: 0.1 },
      { teamId: "t1", teamName: "Red", totalReturnPct: 0.3 },
    ]);
    expect(standings).toEqual([
      { rank: 1, teamId: "t1", teamName: "Red", memberCount: 2, avgReturnPct: 0.2 },
    ]);
  });

  it("ranks teams best average first, tie-breaking by team name", () => {
    const standings = rankTeams([
      { teamId: "t1", teamName: "Bravo", totalReturnPct: 0.05 },
      { teamId: "t2", teamName: "Alpha", totalReturnPct: 0.2 },
      { teamId: "t3", teamName: "Charlie", totalReturnPct: 0.2 },
    ]);
    expect(standings.map((s) => s.teamName)).toEqual(["Alpha", "Charlie", "Bravo"]);
    expect(standings.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it("excludes rows with no team from every group", () => {
    const standings = rankTeams([
      { teamId: "t1", teamName: "Red", totalReturnPct: 0.1 },
      { teamId: null, teamName: null, totalReturnPct: 0.9 },
      { totalReturnPct: 0.5 },
    ]);
    expect(standings).toHaveLength(1);
    expect(standings[0]!.teamName).toBe("Red");
  });

  it("returns an empty board for no input", () => {
    expect(rankTeams([])).toEqual([]);
  });

  it("gives a single-member team its own return as the average", () => {
    const standings = rankTeams([{ teamId: "t1", teamName: "Solo", totalReturnPct: 0.42 }]);
    expect(standings[0]).toEqual({
      rank: 1,
      teamId: "t1",
      teamName: "Solo",
      memberCount: 1,
      avgReturnPct: 0.42,
    });
  });
});

describe("rounding", () => {
  it("keeps money at two decimal places", () => {
    expect(toCents(0.1 + 0.2)).toBe(0.3);
    expect(toCents(1234.5678)).toBe(1234.57);
  });
});
