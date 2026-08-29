import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freshDb, seedSeason, signUp, type TestDb } from "./helpers/pgtest";

/**
 * Schema tests, executed against a real Postgres (see helpers/pgtest.ts).
 *
 * These exist because the interesting failures in this schema are not statement
 * bugs — they are disagreements between the RLS policies and the SECURITY DEFINER
 * functions. Four such defects shipped into the first draft of this migration and
 * every one of them passed a full unit suite, a typecheck and a production build,
 * because none of those execute SQL:
 *
 *   1. execute_trade ran with invoker rights while users deliberately hold no
 *      write policy on holdings/trades — so every player trade was denied.
 *   2. an UPDATE policy on portfolios let a user set their own cash to anything
 *      (RLS cannot restrict an UPDATE to one column).
 *   3. no INSERT policy on league_members, so creating a league did not join you.
 *   4. `using (true)` on leagues published every private invite code.
 *
 * Each has a named regression test below.
 */

let db: TestDb;
let publicLeagueId: string;
let seasonId: string;

beforeAll(async () => {
  db = await freshDb();
  const seeded = await seedSeason(db);
  publicLeagueId = seeded.publicLeagueId;
  seasonId = seeded.seasonId;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

/** execute_trade with the enum cast Postgres needs for a text parameter. */
const TRADE = `select execute_trade($1, $2, $3::trade_side, $4, $5) as result`;

async function cashOf(portfolioId: string) {
  const rows = await db.sql<{ cash: number }>(
    "select cash::float8 as cash from portfolios where id = $1",
    [portfolioId],
  );
  return rows[0]!.cash;
}

async function holdingOf(portfolioId: string, symbol: string) {
  const rows = await db.sql<{ shares: number; avg_cost: number }>(
    `select shares::float8 as shares, avg_cost::float8 as avg_cost
       from holdings where portfolio_id = $1 and symbol = $2`,
    [portfolioId, symbol],
  );
  return rows[0] ?? null;
}

describe("signup bootstrap", () => {
  it("creates a profile, a funded portfolio and public-league membership", async () => {
    const { uid, portfolioId } = await signUp(db, "alice");

    expect(portfolioId).toBeTruthy();
    expect(await cashOf(portfolioId)).toBe(100_000);

    const profile = await db.sql<{ username: string }>(
      "select username from profiles where id = $1",
      [uid],
    );
    expect(profile[0]!.username).toBe("alice");

    const membership = await db.sql(
      "select 1 from portfolios where id = $1 and league_id = $2",
      [portfolioId, publicLeagueId],
    );
    expect(membership).toHaveLength(1);
  });

  it("refuses a username that breaks the format constraint", async () => {
    const uid = await db.createAuthUser("bad@test.local");
    await db.asUser(uid);
    const message = await db.expectDenied("select bootstrap_new_user($1)", ["no spaces!"]);
    expect(message).toMatch(/username_format/);
  });
});

describe("trade execution", () => {
  it("lets a signed-in player trade their own portfolio", async () => {
    // Regression for defect 1. This is the whole product: if this fails, nobody
    // can play. It failed for invoker-rights execute_trade, because the function's
    // own inserts into holdings and trades were denied by RLS.
    const { portfolioId } = await signUp(db, "buyer");

    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 10, 200]);

    expect(await cashOf(portfolioId)).toBe(98_000);
    const holding = await holdingOf(portfolioId, "AAPL");
    expect(holding).toEqual({ shares: 10, avg_cost: 200 });

    const trades = await db.sql<{ side: string; amount: number }>(
      "select side, amount::float8 as amount from trades where portfolio_id = $1",
      [portfolioId],
    );
    expect(trades).toEqual([{ side: "buy", amount: 2000 }]);
  });

  it("share-weights average cost when adding to a position", async () => {
    const { portfolioId } = await signUp(db, "averager");

    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 10, 100]);
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 30, 200]);

    // (10*100 + 30*200) / 40 = 175
    expect(await holdingOf(portfolioId, "AAPL")).toEqual({ shares: 40, avg_cost: 175 });
  });

  it("rejects a buy that costs more than leveraged buying power", async () => {
    // $100,000 cash, leverage 2x → $200,000 buying power. 1001 shares @ $200
    // ($200,200) must still be denied.
    const { portfolioId } = await signUp(db, "overspender");

    const message = await db.expectDenied(TRADE, [portfolioId, "AAPL", "buy", 1001, 200]);
    expect(message).toMatch(/Not enough buying power/);

    // And nothing was written on the way out.
    expect(await cashOf(portfolioId)).toBe(100_000);
    expect(await holdingOf(portfolioId, "AAPL")).toBeNull();
  });

  it("allows spending the balance exactly to the cent", async () => {
    const { portfolioId } = await signUp(db, "allin");
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 500, 200]);
    expect(await cashOf(portfolioId)).toBe(0);
  });

  it("allows a leveraged buy beyond raw cash, taking cash negative as margin debt", async () => {
    // $100,000 cash, default leverage 2x → $200,000 buying power. Spending
    // all of it (1000 shares @ $200) leaves cash at -$100,000: real debt,
    // not a clamp.
    const { portfolioId } = await signUp(db, "leveraged");
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 1000, 200]);
    expect(await cashOf(portfolioId)).toBe(-100_000);
  });

  it("scales buying power with an explicitly chosen leverage, and records it on the trade", async () => {
    // $100,000 cash, 10x → $1,000,000 buying power. 5,000 shares @ $200 is
    // exactly that; one more share must be rejected.
    const { portfolioId } = await signUp(db, "tenx");
    const TRADE_WITH_LEVERAGE = `select execute_trade($1, $2, $3::trade_side, $4, $5, $6) as result`;

    expect(
      await db.expectDenied(TRADE_WITH_LEVERAGE, [portfolioId, "AAPL", "buy", 5001, 200, 10]),
    ).toMatch(/not enough buying power/i);

    await db.sql(TRADE_WITH_LEVERAGE, [portfolioId, "AAPL", "buy", 5000, 200, 10]);
    expect(await cashOf(portfolioId)).toBe(-900_000);

    const trades = await db.sql<{ leverage: number }>(
      "select leverage::float8 as leverage from trades where portfolio_id = $1",
      [portfolioId],
    );
    expect(trades).toEqual([{ leverage: 10 }]);
  });

  it("rejects a leverage outside the offered set", async () => {
    const { portfolioId } = await signUp(db, "badleverage");
    const TRADE_WITH_LEVERAGE = `select execute_trade($1, $2, $3::trade_side, $4, $5, $6) as result`;
    expect(
      await db.expectDenied(TRADE_WITH_LEVERAGE, [portfolioId, "AAPL", "buy", 1, 200, 3]),
    ).toMatch(/invalid leverage/i);
  });

  it("credits a partial sale and leaves average cost alone", async () => {
    const { portfolioId } = await signUp(db, "seller");
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 10, 200]);

    await db.sql(TRADE, [portfolioId, "AAPL", "sell", 4, 250]);

    expect(await cashOf(portfolioId)).toBe(99_000); // 98,000 + 1,000
    // avg_cost still reflects what was paid, so remaining P/L stays honest.
    expect(await holdingOf(portfolioId, "AAPL")).toEqual({ shares: 6, avg_cost: 200 });
  });

  it("removes the position when it is sold out completely", async () => {
    const { portfolioId } = await signUp(db, "closer");
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 10, 200]);

    await db.sql(TRADE, [portfolioId, "AAPL", "sell", 10, 200]);

    expect(await holdingOf(portfolioId, "AAPL")).toBeNull();
    expect(await cashOf(portfolioId)).toBe(100_000);
  });

  it("rejects selling more than is owned, and selling what is not owned", async () => {
    const { portfolioId } = await signUp(db, "shorter");
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 10, 200]);

    expect(await db.expectDenied(TRADE, [portfolioId, "AAPL", "sell", 11, 200])).toMatch(
      /You only own/,
    );
    expect(await db.expectDenied(TRADE, [portfolioId, "MSFT", "sell", 1, 400])).toMatch(
      /do not own/,
    );
  });

  it("rejects non-positive quantities and prices", async () => {
    const { portfolioId } = await signUp(db, "zeroes");

    expect(await db.expectDenied(TRADE, [portfolioId, "AAPL", "buy", 0, 200])).toMatch(
      /greater than zero/,
    );
    expect(await db.expectDenied(TRADE, [portfolioId, "AAPL", "buy", -5, 200])).toMatch(
      /greater than zero/,
    );
    expect(await db.expectDenied(TRADE, [portfolioId, "AAPL", "buy", 1, 0])).toMatch(
      /No usable price/,
    );
  });
});

describe("short selling", () => {
  it("opens a short, crediting proceeds like a sell", async () => {
    const { portfolioId } = await signUp(db, "opener");
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 10, 200]);

    expect(await cashOf(portfolioId)).toBe(102_000); // 100,000 + 2,000 proceeds
    expect(await holdingOf(portfolioId, "AAPL")).toEqual({ shares: -10, avg_cost: 200 });

    const trades = await db.sql<{ side: string; amount: number }>(
      "select side, amount::float8 as amount from trades where portfolio_id = $1",
      [portfolioId],
    );
    expect(trades).toEqual([{ side: "short", amount: 2000 }]);
  });

  it("share-weights average cost when adding to a short", async () => {
    const { portfolioId } = await signUp(db, "shortAverager");
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 10, 100]);
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 30, 200]);

    // (10*100 + 30*200) / 40 = 175, same formula as adding to a long.
    expect(await holdingOf(portfolioId, "AAPL")).toEqual({ shares: -40, avg_cost: 175 });
  });

  it("partially covers, leaving average cost unchanged", async () => {
    const { portfolioId } = await signUp(db, "partialCover");
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 10, 200]);

    await db.sql(TRADE, [portfolioId, "AAPL", "cover", 4, 150]);

    expect(await cashOf(portfolioId)).toBe(101_400); // 102,000 - 600
    expect(await holdingOf(portfolioId, "AAPL")).toEqual({ shares: -6, avg_cost: 200 });
  });

  it("removes the position when fully covered", async () => {
    const { portfolioId } = await signUp(db, "fullCover");
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 10, 200]);

    await db.sql(TRADE, [portfolioId, "AAPL", "cover", 10, 150]);

    expect(await holdingOf(portfolioId, "AAPL")).toBeNull();
    expect(await cashOf(portfolioId)).toBe(100_500); // 100,000 + (2,000 - 1,500) profit
  });

  it("rejects over-covering and covering what is not short", async () => {
    const { portfolioId } = await signUp(db, "overCoverer");
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 10, 200]);

    expect(
      await db.expectDenied(TRADE, [portfolioId, "AAPL", "cover", 11, 200]),
    ).toMatch(/only short/);
    expect(
      await db.expectDenied(TRADE, [portfolioId, "MSFT", "cover", 1, 400]),
    ).toMatch(/not short/);
  });

  it("stops shorting a symbol currently held long, and buying one currently short", async () => {
    const { portfolioId } = await signUp(db, "flipper");
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 10, 200]);
    expect(await db.expectDenied(TRADE, [portfolioId, "AAPL", "short", 1, 200])).toMatch(
      /long/i,
    );

    const { portfolioId: p2 } = await signUp(db, "flipper2");
    await db.sql(TRADE, [p2, "MSFT", "short", 10, 200]);
    expect(await db.expectDenied(TRADE, [p2, "MSFT", "buy", 1, 200])).toMatch(/short/i);
  });

  it("stops selling or shorting further once a position is already short", async () => {
    const { portfolioId } = await signUp(db, "confused");
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 10, 200]);
    expect(await db.expectDenied(TRADE, [portfolioId, "AAPL", "sell", 1, 200])).toMatch(
      /cover/i,
    );
  });

  it("caps shorting at 1:1 available cash x leverage, aggregated across symbols", async () => {
    // 100,000 cash. Short $60,000 of AAPL — leaves $40,000 available,
    // $80,000 at leverage 2x. A second short needing more than that must be
    // rejected even though raw cash (which briefly reads $160,000 after the
    // first trade) would cover it — this is the rule that stops shorting
    // from being free leverage on top of the leverage it already has.
    const { portfolioId } = await signUp(db, "leverageChecker");
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 300, 200]); // $60,000

    expect(await cashOf(portfolioId)).toBe(160_000);
    expect(
      await db.expectDenied(TRADE, [portfolioId, "MSFT", "short", 201, 400]), // $80,400
    ).toMatch(/not enough buying power to short/i);

    // Exactly at the (leveraged) limit succeeds.
    await db.sql(TRADE, [portfolioId, "MSFT", "short", 200, 400]); // $80,000
    expect(await cashOf(portfolioId)).toBe(240_000);
  });

  it("caps a buy at the leveraged baseline no matter how much has been shorted", async () => {
    // Buying is value-neutral (cash for stock at the current price), so it is
    // bounded by (cash minus liability) x leverage — the same $200,000
    // ceiling as if nothing had ever been shorted, not squeezed further by
    // the short's own inflated cash balance.
    const { portfolioId } = await signUp(db, "buyAfterShort");
    await db.sql(TRADE, [portfolioId, "AAPL", "short", 300, 200]); // $60,000, cash -> 160,000

    expect(
      await db.expectDenied(TRADE, [portfolioId, "MSFT", "buy", 501, 400]), // $200,400
    ).toMatch(/not enough buying power/i);

    await db.sql(TRADE, [portfolioId, "MSFT", "buy", 500, 400]); // exactly $200,000
    expect(await cashOf(portfolioId)).toBe(-40_000); // 160,000 - 200,000, margin debt
  });

  it("bounds total short liability at the cash baseline, not just a single trade", async () => {
    // Regression: an earlier version of this check computed "available cash"
    // as cash - liability. Cash and liability rise by the same amount on
    // every short, so that quantity is invariant — it can only ever bound a
    // single trade's own size, never the running total across many. This
    // shorts a different symbol $10,000 at a time and confirms the tenth
    // exactly exhausts the $100,000 collateral, and an eleventh is rejected.
    const { portfolioId } = await signUp(db, "repeatedShorter");
    for (let i = 0; i < 10; i++) {
      await db.sql(TRADE, [portfolioId, `SYM${i}`, "short", 50, 200]); // $10,000 each
    }
    expect(await cashOf(portfolioId)).toBe(200_000); // 100,000 + 10 * 10,000

    expect(
      await db.expectDenied(TRADE, [portfolioId, "SYM10", "short", 1, 200]),
    ).toMatch(/not enough buying power to short/i);
  });
});

describe("limit orders", () => {
  const PLACE = `select place_limit_order($1, $2, $3::trade_side, $4, $5, $6) as id`;
  const CANCEL = `select cancel_limit_order($1)`;
  const FILL = `select fill_pending_order($1, $2, $3) as result`;

  async function countPending(portfolioId: string) {
    const rows = await db.sql<{ n: string }>(
      "select count(*)::text as n from pending_orders where portfolio_id = $1",
      [portfolioId],
    );
    return Number(rows[0]!.n);
  }

  it("places a buy limit order and leaves it pending until cancelled", async () => {
    const { portfolioId } = await signUp(db, "limitBuyer");

    const placed = await db.sql<{ id: string }>(PLACE, [
      portfolioId, "AAPL", "buy", "shares", 10, 150,
    ]);
    expect(placed[0]!.id).toBeTruthy();
    expect(await countPending(portfolioId)).toBe(1);

    await db.sql(CANCEL, [placed[0]!.id]);
    expect(await countPending(portfolioId)).toBe(0);
    // Cancelling never touches cash or holdings — nothing was ever spent.
    expect(await cashOf(portfolioId)).toBe(100_000);
  });

  it("rejects placing an order against someone else's portfolio", async () => {
    const victim = await signUp(db, "limitVictim");
    const attacker = await signUp(db, "limitAttacker");

    await db.asUser(attacker.uid);
    const message = await db.expectDenied(PLACE, [
      victim.portfolioId, "AAPL", "buy", "shares", 10, 150,
    ]);
    expect(message).toMatch(/not your portfolio/i);
  });

  it("rejects a sell limit order for shares that are not held", async () => {
    const { portfolioId } = await signUp(db, "limitOverseller");
    const message = await db.expectDenied(PLACE, [
      portfolioId, "AAPL", "sell", "shares", 10, 250,
    ]);
    expect(message).toMatch(/only own/i);
  });

  it("rejects short or cover as a limit order side", async () => {
    const { portfolioId } = await signUp(db, "limitShorter");
    expect(
      await db.expectDenied(PLACE, [portfolioId, "AAPL", "short", "shares", 10, 150]),
    ).toMatch(/buy or sell only/i);
  });

  it("rejects cancelling someone else's order", async () => {
    const owner = await signUp(db, "limitOwner");
    // Placed while still signed in as the owner — signUp leaves the caller
    // acting as whoever it just created, so this has to happen before nosy
    // signs up and takes over that context.
    const placed = await db.sql<{ id: string }>(PLACE, [
      owner.portfolioId, "AAPL", "buy", "shares", 10, 150,
    ]);

    await signUp(db, "limitNosy");
    const message = await db.expectDenied(CANCEL, [placed[0]!.id]);
    expect(message).toMatch(/not your order/i);
  });

  it("rejects filling an order whose price has not crossed the target", async () => {
    const { portfolioId } = await signUp(db, "limitEarly");
    const placed = await db.sql<{ id: string }>(PLACE, [
      portfolioId, "AAPL", "buy", "shares", 10, 150,
    ]);

    // Target is $150 or below; $160 has not crossed it yet.
    const message = await db.expectDenied(FILL, [placed[0]!.id, 160, 10]);
    expect(message).toMatch(/not due/i);
    expect(await countPending(portfolioId)).toBe(1);
  });

  it("fills a due buy order exactly like execute_trade, then clears the pending row", async () => {
    const { portfolioId } = await signUp(db, "limitFiller");
    const placed = await db.sql<{ id: string }>(PLACE, [
      portfolioId, "AAPL", "buy", "shares", 10, 150,
    ]);

    // Fills at the live price actually crossed, not the target — here $140,
    // better than the $150 limit, same as a real limit order.
    await db.sql(FILL, [placed[0]!.id, 140, 10]);

    expect(await cashOf(portfolioId)).toBe(98_600); // 100,000 - 10*140
    expect(await holdingOf(portfolioId, "AAPL")).toEqual({ shares: 10, avg_cost: 140 });
    expect(await countPending(portfolioId)).toBe(0);

    const trades = await db.sql<{ side: string; amount: number }>(
      "select side, amount::float8 as amount from trades where portfolio_id = $1",
      [portfolioId],
    );
    expect(trades).toEqual([{ side: "buy", amount: 1400 }]);
  });

  it("fills a buy limit order at the leverage chosen when it was placed, not the default", async () => {
    // $100,000 cash. 700 shares @ $140 = $98,000 — affordable outright, but
    // 700 shares @ $150 (the higher price it might fill at) times a plain 1x
    // wouldn't leave room to also prove the leverage carried through, so this
    // asks for far more than 1x could ever afford: 3,500 shares @ $140 =
    // $490,000, only payable at 5x ($500,000 buying power).
    const PLACE_WITH_LEVERAGE = `select place_limit_order($1, $2, $3::trade_side, $4, $5, $6, $7) as id`;
    const { portfolioId } = await signUp(db, "limitLeveraged");
    const placed = await db.sql<{ id: string }>(PLACE_WITH_LEVERAGE, [
      portfolioId, "AAPL", "buy", "shares", 3500, 150, 5,
    ]);

    await db.sql(FILL, [placed[0]!.id, 140, 3500]);

    expect(await cashOf(portfolioId)).toBe(100_000 - 3500 * 140);
    const trades = await db.sql<{ leverage: number }>(
      "select leverage::float8 as leverage from trades where portfolio_id = $1",
      [portfolioId],
    );
    expect(trades).toEqual([{ leverage: 5 }]);
  });

  it("fills a due sell order at or above its target", async () => {
    const { portfolioId } = await signUp(db, "limitSeller");
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 10, 100]);

    const placed = await db.sql<{ id: string }>(PLACE, [
      portfolioId, "AAPL", "sell", "shares", 10, 120,
    ]);
    await db.sql(FILL, [placed[0]!.id, 125, 10]);

    expect(await holdingOf(portfolioId, "AAPL")).toBeNull();
    expect(await cashOf(portfolioId)).toBe(100_250); // 100,000 - 1,000 (buy) + 1,250 (sell @125)
  });

  it("leaves an order pending when it is due but the account can no longer afford it", async () => {
    // Spend the account down first, then a previously-placeable buy limit
    // order can no longer fill even though its price target is crossed —
    // fill_pending_order must not let it overspend just because it was
    // queued earlier.
    const { portfolioId } = await signUp(db, "limitBroke");
    const placed = await db.sql<{ id: string }>(PLACE, [
      portfolioId, "AAPL", "buy", "shares", 10, 150,
    ]);
    await db.sql(TRADE, [portfolioId, "MSFT", "buy", 500, 400]); // spends the full $200,000 buying power

    const message = await db.expectDenied(FILL, [placed[0]!.id, 140, 10]);
    expect(message).toMatch(/not enough buying power/i);
    expect(await countPending(portfolioId)).toBe(1);
  });
});

describe("trade authorisation", () => {
  it("stops a player trading somebody else's portfolio", async () => {
    const victim = await signUp(db, "victim");
    const attacker = await signUp(db, "attacker");

    // Signed in as the attacker, aimed at the victim's portfolio id — which is
    // public information, since the leaderboard exposes it.
    await db.asUser(attacker.uid);
    const message = await db.expectDenied(TRADE, [
      victim.portfolioId,
      "AAPL",
      "buy",
      1,
      200,
    ]);
    expect(message).toMatch(/not your portfolio/i);
    expect(await cashOf(victim.portfolioId)).toBe(100_000);
  });

  // The next two tests caught a NULL-logic hole in the authorisation guard. It was
  // written as `v_owner = auth.uid() or ...`, which evaluates to NULL — not false —
  // when either side is null. `if not NULL then` does not fire, so the guard waved
  // through precisely the two cases below: a null-owner special portfolio, and an
  // unauthenticated caller. Both are now forced to non-null booleans.
  it("stops a player trading the AI, Human or benchmark portfolio", async () => {
    await db.asSuperuser();
    const special = await db.sql<{ id: string }>(
      `insert into portfolios (season_id, league_id, owner_type, display_name, cash, starting_balance)
       values ($1, $2, 'ai', 'StockOff AI', 100000, 100000) returning id`,
      [seasonId, publicLeagueId],
    );
    const aiId = special[0]!.id;

    const player = await signUp(db, "meddler");
    await db.asUser(player.uid);
    expect(await db.expectDenied(TRADE, [aiId, "AAPL", "buy", 1, 200])).toMatch(
      /not your portfolio/i,
    );

    // An admin may, which is how the AI book gets rebalanced.
    await db.asSuperuser();
    await db.sql("update profiles set is_admin = true where id = $1", [player.uid]);
    await db.asUser(player.uid);
    await db.sql(TRADE, [aiId, "AAPL", "buy", 5, 200]);
    expect(await cashOf(aiId)).toBe(99_000);
  });

  it("lets the service role trade any portfolio, so seeding works", async () => {
    const { portfolioId } = await signUp(db, "seeded");
    await db.asService();
    await db.sql(TRADE, [portfolioId, "MSFT", "buy", 10, 400]);
    expect(await cashOf(portfolioId)).toBe(96_000);
  });

  it("stops an anonymous visitor trading at all", async () => {
    const { portfolioId } = await signUp(db, "anonvictim");

    await db.asSuperuser();
    const orphan = await db.sql<{ id: string }>(
      `insert into portfolios (season_id, league_id, owner_type, display_name, cash, starting_balance)
       values ($1, $2, 'benchmark', 'S&P 500', 100000, 100000) returning id`,
      [seasonId, publicLeagueId],
    );

    await db.asAnon();
    // A real player's portfolio: owner is set, actor is null.
    expect(await db.expectDenied(TRADE, [portfolioId, "AAPL", "buy", 1, 200])).toMatch(
      /not your portfolio/i,
    );
    // And the double-null case — null owner, null actor — which a naive
    // `is not distinct from` rewrite would have let straight through.
    expect(
      await db.expectDenied(TRADE, [orphan[0]!.id, "AAPL", "buy", 1, 200]),
    ).toMatch(/not your portfolio/i);
  });
});

describe("league chat", () => {
  const POST = `select post_league_message($1, $2) as id`;
  const DELETE_MSG = `select delete_league_message($1)`;

  /** A fresh private league plus a portfolio for `uid` in it — a real
   *  membership, the same way `create_portfolio_in_league` gives one to
   *  anyone joining a league for real. */
  async function privateLeagueWithMember(uid: string, name: string, code: string) {
    const league = await db.sql<{ id: string }>(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, $2, $3, false, $4) returning id`,
      [seasonId, name, code, uid],
    );
    const leagueId = league[0]!.id;
    await db.sql("select create_portfolio_in_league($1, $2, $3)", [leagueId, uid, name]);
    return leagueId;
  }

  async function countMessages(leagueId: string) {
    const rows = await db.sql<{ n: string }>(
      "select count(*)::text as n from league_messages where league_id = $1",
      [leagueId],
    );
    return Number(rows[0]!.n);
  }

  it("lets a member post, and the row lands with the right sender/body/league", async () => {
    const { portfolioId } = await signUp(db, "chatty");
    const posted = await db.sql<{ id: string }>(POST, [publicLeagueId, "hello league"]);
    expect(posted[0]!.id).toBeTruthy();

    const rows = await db.sql<{ sender_portfolio_id: string; body: string; league_id: string }>(
      "select sender_portfolio_id, body, league_id from league_messages where id = $1",
      [posted[0]!.id],
    );
    expect(rows[0]).toEqual({
      sender_portfolio_id: portfolioId,
      body: "hello league",
      league_id: publicLeagueId,
    });
  });

  it("trims and rejects an empty or whitespace-only body", async () => {
    await signUp(db, "mumbler");
    expect(await db.expectDenied(POST, [publicLeagueId, "   "])).toMatch(/empty/i);
    expect(await db.expectDenied(POST, [publicLeagueId, ""])).toMatch(/empty/i);
  });

  it("rejects a body over 500 characters", async () => {
    await signUp(db, "ranter");
    expect(await db.expectDenied(POST, [publicLeagueId, "x".repeat(501)])).toMatch(
      /too long|500/i,
    );
    // Exactly at the limit succeeds.
    await db.sql(POST, [publicLeagueId, "x".repeat(500)]);
  });

  it("rejects rapid re-posting from the same sender, but not from a different one", async () => {
    await signUp(db, "spammer");
    await db.sql(POST, [publicLeagueId, "first"]);
    expect(await db.expectDenied(POST, [publicLeagueId, "second"])).toMatch(/too fast/i);

    // A different sender is unaffected by the first sender's cooldown.
    await signUp(db, "bystander");
    await db.sql(POST, [publicLeagueId, "unrelated"]);
  });

  it("rejects posting to a league the caller has no portfolio in", async () => {
    const owner = await signUp(db, "clubfounder");
    const leagueId = await privateLeagueWithMember(owner.uid, "Founders Club", "FOUND1");

    await signUp(db, "outsider2");
    expect(await db.expectDenied(POST, [leagueId, "let me in"])).toMatch(/not a member/i);
  });

  it("rejects posting from an anonymous visitor, even to the public league", async () => {
    await db.asAnon();
    expect(await db.expectDenied(POST, [publicLeagueId, "hi"])).toMatch(/sign in/i);
  });

  it("hides a private league's messages from a non-member", async () => {
    const owner = await signUp(db, "privateowner");
    const leagueId = await privateLeagueWithMember(owner.uid, "Hidden Club", "HIDE01");
    await db.sql(POST, [leagueId, "members only"]);

    await signUp(db, "nosyneighbour");
    expect(
      await db.sql("select 1 from league_messages where league_id = $1", [leagueId]),
    ).toHaveLength(0);
  });

  it("hides even the public league's messages from an anonymous visitor", async () => {
    // The core assertion: chat is stricter than `leagues readable`'s
    // is_public bypass — publicness there is about the leaderboard, not chat.
    await signUp(db, "publicposter");
    await db.sql(POST, [publicLeagueId, "visible to members only"]);

    await db.asAnon();
    expect(
      await db.sql("select 1 from league_messages where league_id = $1", [publicLeagueId]),
    ).toHaveLength(0);
  });

  it("lets a sender delete their own message", async () => {
    await signUp(db, "selfdeleter");
    const posted = await db.sql<{ id: string }>(POST, [publicLeagueId, "oops"]);
    await db.sql(DELETE_MSG, [posted[0]!.id]);
    expect(
      await db.sql("select 1 from league_messages where id = $1", [posted[0]!.id]),
    ).toHaveLength(0);
  });

  it("stops a different member deleting someone else's message", async () => {
    await signUp(db, "author1");
    const posted = await db.sql<{ id: string }>(POST, [publicLeagueId, "mine"]);

    await signUp(db, "meddler2");
    expect(await db.expectDenied(DELETE_MSG, [posted[0]!.id])).toMatch(/own messages/i);
  });

  it("lets an admin delete any member's message, even without a portfolio in that league", async () => {
    const owner = await signUp(db, "modtarget");
    const leagueId = await privateLeagueWithMember(owner.uid, "Mod Club", "MOD001");
    const posted = await db.sql<{ id: string }>(POST, [leagueId, "flag me"]);

    const { uid: adminUid } = await signUp(db, "modadmin");
    await db.asSuperuser();
    await db.sql("update profiles set is_admin = true where id = $1", [adminUid]);

    await db.asUser(adminUid);
    await db.sql(DELETE_MSG, [posted[0]!.id]);
    expect(
      await db.sql("select 1 from league_messages where id = $1", [posted[0]!.id]),
    ).toHaveLength(0);
  });

  it("lets the service role delete a message", async () => {
    await signUp(db, "svcauthor");
    const posted = await db.sql<{ id: string }>(POST, [publicLeagueId, "delete me"]);

    await db.asService();
    await db.sql(DELETE_MSG, [posted[0]!.id]);
    expect(
      await db.sql("select 1 from league_messages where id = $1", [posted[0]!.id]),
    ).toHaveLength(0);
  });

  it("keeps messages scoped per league", async () => {
    const owner = await signUp(db, "scopeowner");
    const leagueA = await privateLeagueWithMember(owner.uid, "League A", "SCOPEA");
    const leagueB = await privateLeagueWithMember(owner.uid, "League B", "SCOPEB");

    await db.sql(POST, [leagueA, "only in A"]);
    expect(await countMessages(leagueA)).toBe(1);
    expect(await countMessages(leagueB)).toBe(0);
  });
});

describe("direct write attempts", () => {
  it("stops a player editing their own cash balance", async () => {
    // Regression for defect 2 — the one that made all the server-side price
    // validation pointless. RLS cannot restrict an UPDATE to a single column, so
    // the fix is that users have no UPDATE policy on portfolios at all.
    const { uid, portfolioId } = await signUp(db, "cheater");
    await db.asUser(uid);

    const rows = await db.sql(
      "update portfolios set cash = 99999999 where id = $1 returning id",
      [portfolioId],
    );
    // RLS makes the row invisible to the UPDATE rather than raising: zero rows
    // affected is the denial.
    expect(rows).toHaveLength(0);
    expect(await cashOf(portfolioId)).toBe(100_000);
  });

  it("stops a player fabricating a holding", async () => {
    const { uid, portfolioId } = await signUp(db, "fabricator");
    await db.asUser(uid);

    const message = await db.expectDenied(
      `insert into holdings (portfolio_id, symbol, shares, avg_cost)
       values ($1, 'AAPL', 1000, 1)`,
      [portfolioId],
    );
    expect(message).toMatch(/row-level security|violates/i);
  });

  it("stops a player writing a fake trade into the log", async () => {
    const { uid, portfolioId } = await signUp(db, "forger");
    await db.asUser(uid);

    const message = await db.expectDenied(
      `insert into trades (portfolio_id, symbol, side, shares, price, amount)
       values ($1, 'AAPL', 'buy', 1, 1, 1)`,
      [portfolioId],
    );
    expect(message).toMatch(/row-level security|violates/i);
  });

  it("stops a player renaming somebody else", async () => {
    const target = await signUp(db, "target");
    const other = await signUp(db, "other");

    await db.asUser(other.uid);
    const rows = await db.sql(
      "update profiles set username = 'stolen' where id = $1 returning id",
      [target.uid],
    );
    expect(rows).toHaveLength(0);
  });

  it("stops a player writing a fake chat message, bypassing post_league_message", async () => {
    const { uid, portfolioId } = await signUp(db, "chatforger");
    await db.asUser(uid);

    const message = await db.expectDenied(
      `insert into league_messages (league_id, sender_portfolio_id, body)
       values ($1, $2, 'fake')`,
      [publicLeagueId, portfolioId],
    );
    expect(message).toMatch(/row-level security|violates/i);
  });
});

describe("teams", () => {
  const JOIN_TEAM = `select join_team_by_code($1) as result`;

  /** A fresh private league plus a portfolio for `uid` in it. */
  async function privateLeagueWithMember(uid: string, name: string, code: string) {
    const league = await db.sql<{ id: string }>(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, $2, $3, false, $4) returning id`,
      [seasonId, name, code, uid],
    );
    const leagueId = league[0]!.id;
    await db.sql("select create_portfolio_in_league($1, $2, $3)", [leagueId, uid, name]);
    return leagueId;
  }

  /** Inserts a team as whichever user the caller is currently acting as —
   *  exercises the real INSERT RLS policy, not a bypass. */
  async function insertTeam(leagueId: string, name: string, code: string) {
    const rows = await db.sql<{ id: string }>(
      "insert into teams (league_id, name, code, created_by) values ($1, $2, $3, auth.uid()) returning id",
      [leagueId, name, code],
    );
    return rows[0]!.id;
  }

  it("lets the league creator add a team, but denies a non-creator member", async () => {
    const creator = await signUp(db, "teamcreator");
    const leagueId = await privateLeagueWithMember(creator.uid, "Creator League", "TEAM001");

    await db.asUser(creator.uid);
    const teamId = await insertTeam(leagueId, "Red", "REDCODE1");
    expect(teamId).toBeTruthy();

    await signUp(db, "teammember");
    await db.sql("select join_league_by_code($1)", ["TEAM001"]);

    expect(
      await db.expectDenied(
        "insert into teams (league_id, name, code, created_by) values ($1, 'Blue', 'BLUECODE', auth.uid())",
        [leagueId],
      ),
    ).toMatch(/row-level security|violates/i);
  });

  it("lets a team's own creator select its row, including the code", async () => {
    const creator = await signUp(db, "teamowner2");
    const leagueId = await privateLeagueWithMember(creator.uid, "Owner League", "TEAM002");
    await db.asUser(creator.uid);
    const teamId = await insertTeam(leagueId, "Alpha", "ALPHA01");

    const rows = await db.sql<{ code: string }>("select code from teams where id = $1", [teamId]);
    expect(rows).toEqual([{ code: "ALPHA01" }]);
  });

  it("hides a team's row from a league member who is not on it and did not create it", async () => {
    const creator = await signUp(db, "teamowner3");
    const leagueId = await privateLeagueWithMember(creator.uid, "Hidden Team League", "TEAM003");
    await db.asUser(creator.uid);
    const teamId = await insertTeam(leagueId, "Gamma", "GAMMA01");

    await signUp(db, "teamoutsider");
    await db.sql("select join_league_by_code($1)", ["TEAM003"]);

    expect(await db.sql("select 1 from teams where id = $1", [teamId])).toHaveLength(0);
  });

  it("join_team_by_code joins the league and assigns the team in one call", async () => {
    const creator = await signUp(db, "teamowner4");
    const leagueId = await privateLeagueWithMember(creator.uid, "Join League", "TEAM004");
    await db.asUser(creator.uid);
    const teamId = await insertTeam(leagueId, "Delta", "DELTA01");

    const { uid: joinerUid } = await signUp(db, "teamjoiner");
    await db.sql(JOIN_TEAM, ["DELTA01"]);

    const rows = await db.sql<{ team_id: string }>(
      "select team_id from portfolios where league_id = $1 and profile_id = $2",
      [leagueId, joinerUid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.team_id).toBe(teamId);
  });

  it("lets a member who joined via team code then select that team's row", async () => {
    const creator = await signUp(db, "teamowner5");
    const leagueId = await privateLeagueWithMember(creator.uid, "Member Visible League", "TEAM005");
    await db.asUser(creator.uid);
    const teamId = await insertTeam(leagueId, "Epsilon", "EPSILON1");

    await signUp(db, "teamjoiner2");
    await db.sql(JOIN_TEAM, ["EPSILON1"]);

    expect(await db.sql("select 1 from teams where id = $1", [teamId])).toHaveLength(1);
  });

  it("switches team_id when a member joins a different team's code in the same league", async () => {
    const creator = await signUp(db, "teamowner6");
    const leagueId = await privateLeagueWithMember(creator.uid, "Switch League", "TEAM006");
    await db.asUser(creator.uid);
    await insertTeam(leagueId, "TeamA", "SWITCHA1");
    const teamB = await insertTeam(leagueId, "TeamB", "SWITCHB1");

    const { uid: switcherUid } = await signUp(db, "teamswitcher");
    await db.sql(JOIN_TEAM, ["SWITCHA1"]);
    await db.sql(JOIN_TEAM, ["SWITCHB1"]);

    const rows = await db.sql<{ team_id: string }>(
      "select team_id from portfolios where league_id = $1 and profile_id = $2",
      [leagueId, switcherUid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.team_id).toBe(teamB);
  });

  it("rejects join_team_by_code with an unknown code", async () => {
    await signUp(db, "badcodeuser");
    expect(await db.expectDenied(JOIN_TEAM, ["NOPE9999"])).toMatch(/no team with that code/i);
  });

  it("exposes team names, not codes, to anyone including anonymous callers", async () => {
    const creator = await signUp(db, "teamowner8");
    const leagueId = await privateLeagueWithMember(creator.uid, "Anon League", "TEAM008");
    await db.asUser(creator.uid);
    await insertTeam(leagueId, "Visible", "HIDDEN01");

    await db.asAnon();
    const rows = await db.sql<{ id: string; name: string }>(
      "select * from league_teams($1)",
      [leagueId],
    );
    expect(rows).toEqual([{ id: expect.any(String), name: "Visible" }]);
    expect(Object.keys(rows[0]!)).not.toContain("code");
  });

  it("stops the trigger from letting a portfolio's team belong to a different league", async () => {
    // No ordinary write path can reach this — portfolios has no UPDATE policy
    // for regular users at all, so this is arranged directly as superuser to
    // prove the trigger itself, not a real attack surface (see the migration's
    // header comment).
    const creatorA = await signUp(db, "trigcreatorA");
    const leagueA = await privateLeagueWithMember(creatorA.uid, "Trigger League A", "TRIGA01");
    await db.asUser(creatorA.uid);
    const teamInA = await insertTeam(leagueA, "TeamInA", "TRIGTEAMA");

    const creatorB = await signUp(db, "trigcreatorB");
    const leagueB = await privateLeagueWithMember(creatorB.uid, "Trigger League B", "TRIGB01");

    await db.asSuperuser();
    const message = await db.expectDenied(
      "update portfolios set team_id = $1 where league_id = $2 and profile_id = $3",
      [teamInA, leagueB, creatorB.uid],
    );
    expect(message).toMatch(/does not belong to league/i);
  });
});

describe("portfolio snapshots", () => {
  it("lets the owner insert then update (overwrite) their own day's snapshot", async () => {
    const { portfolioId } = await signUp(db, "snapshotowner");
    await db.sql(
      `insert into portfolio_snapshots (portfolio_id, snapshot_date, total_value, total_return_pct)
       values ($1, current_date, 100000, 0)`,
      [portfolioId],
    );
    // Same-day re-visit overwrites, keeping the latest value seen.
    await db.sql(
      `update portfolio_snapshots set total_value = 101000, total_return_pct = 0.01
       where portfolio_id = $1 and snapshot_date = current_date`,
      [portfolioId],
    );

    const rows = await db.sql<{ total_value: string }>(
      "select total_value from portfolio_snapshots where portfolio_id = $1",
      [portfolioId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.total_value)).toBe(101000);
  });

  it("stops a user inserting or updating another portfolio's snapshot", async () => {
    const owner = await signUp(db, "snapshotvictim");
    await signUp(db, "snapshotattacker");

    expect(
      await db.expectDenied(
        `insert into portfolio_snapshots (portfolio_id, snapshot_date, total_value, total_return_pct)
         values ($1, current_date, 999999, 9)`,
        [owner.portfolioId],
      ),
    ).toMatch(/row-level security|violates/i);

    await db.asSuperuser();
    await db.sql(
      `insert into portfolio_snapshots (portfolio_id, snapshot_date, total_value, total_return_pct)
       values ($1, current_date, 100000, 0)`,
      [owner.portfolioId],
    );

    await db.asUser((await signUp(db, "snapshotattacker2")).uid);
    const rows = await db.sql(
      `update portfolio_snapshots set total_value = 1 where portfolio_id = $1 returning portfolio_id`,
      [owner.portfolioId],
    );
    expect(rows).toHaveLength(0);
  });

  it("is readable by anyone, including an anonymous visitor", async () => {
    const { portfolioId } = await signUp(db, "snapshotpublic");
    await db.sql(
      `insert into portfolio_snapshots (portfolio_id, snapshot_date, total_value, total_return_pct)
       values ($1, current_date, 100000, 0)`,
      [portfolioId],
    );

    await db.asAnon();
    const rows = await db.sql(
      "select 1 from portfolio_snapshots where portfolio_id = $1",
      [portfolioId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("competitor snapshots", () => {
  const RECORD = `select record_competitor_snapshot($1, $2, $3)`;

  async function privateLeagueWithMember(uid: string, name: string, code: string) {
    const league = await db.sql<{ id: string }>(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, $2, $3, false, $4) returning id`,
      [seasonId, name, code, uid],
    );
    const leagueId = league[0]!.id;
    await db.sql("select create_portfolio_in_league($1, $2, $3)", [leagueId, uid, name]);
    return leagueId;
  }

  /** An ai-type competitor portfolio in the given league, inserted the way
   *  the seeder/admin flow would (no owning profile). */
  async function insertCompetitor(leagueId: string) {
    await db.asSuperuser();
    const rows = await db.sql<{ id: string }>(
      `insert into portfolios (season_id, league_id, owner_type, display_name, cash, starting_balance)
       values ($1, $2, 'ai', 'StockOff AI', 100000, 100000) returning id`,
      [seasonId, leagueId],
    );
    return rows[0]!.id;
  }

  it("lets a league member record and overwrite that league's ai portfolio snapshot", async () => {
    const member = await signUp(db, "compsnapmember");
    const leagueId = await privateLeagueWithMember(member.uid, "Comp Snap League", "COMPSNAP1");
    const aiId = await insertCompetitor(leagueId);

    await db.asUser(member.uid);
    await db.sql(RECORD, [aiId, 100000, 0]);
    await db.sql(RECORD, [aiId, 102000, 0.02]);

    const rows = await db.sql<{ total_value: string }>(
      "select total_value from portfolio_snapshots where portfolio_id = $1",
      [aiId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.total_value)).toBe(102000);
  });

  it("rejects recording for a user-type portfolio", async () => {
    const member = await signUp(db, "compsnapuser");
    const leagueId = await privateLeagueWithMember(member.uid, "Comp Snap League 2", "COMPSNAP2");

    const victim = await signUp(db, "compsnapvictim");
    await db.sql("select join_league_by_code($1)", ["COMPSNAP2"]);
    const victimPortfolio = await db.sql<{ id: string }>(
      "select id from portfolios where league_id = $1 and profile_id = $2",
      [leagueId, victim.uid],
    );

    await db.asUser(member.uid);
    expect(await db.expectDenied(RECORD, [victimPortfolio[0]!.id, 999999, 9])).toMatch(
      /not a competitor portfolio/i,
    );
  });

  it("rejects a caller with no portfolio in that portfolio's league", async () => {
    const creator = await signUp(db, "compsnapcreator");
    const leagueId = await privateLeagueWithMember(creator.uid, "Comp Snap League 3", "COMPSNAP3");
    const aiId = await insertCompetitor(leagueId);

    await signUp(db, "compsnapoutsider");
    expect(await db.expectDenied(RECORD, [aiId, 100000, 0])).toMatch(/not a member/i);
  });

  it("rejects an unauthenticated caller", async () => {
    const creator = await signUp(db, "compsnapcreator2");
    const leagueId = await privateLeagueWithMember(creator.uid, "Comp Snap League 4", "COMPSNAP4");
    const aiId = await insertCompetitor(leagueId);

    await db.asAnon();
    expect(await db.expectDenied(RECORD, [aiId, 100000, 0])).toMatch(/sign in/i);
  });
});

describe("team chat", () => {
  const POST_TEAM = `select post_league_message($1, $2, $3) as id`;
  const JOIN_TEAM_CODE = `select join_team_by_code($1) as result`;

  async function privateLeagueWithMember(uid: string, name: string, code: string) {
    const league = await db.sql<{ id: string }>(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, $2, $3, false, $4) returning id`,
      [seasonId, name, code, uid],
    );
    const leagueId = league[0]!.id;
    await db.sql("select create_portfolio_in_league($1, $2, $3)", [leagueId, uid, name]);
    return leagueId;
  }

  async function insertTeam(leagueId: string, name: string, code: string) {
    const rows = await db.sql<{ id: string }>(
      "insert into teams (league_id, name, code, created_by) values ($1, $2, $3, auth.uid()) returning id",
      [leagueId, name, code],
    );
    return rows[0]!.id;
  }

  it("hides a team-scoped message from a league member who is not on that team", async () => {
    const creator = await signUp(db, "tchatcreator1");
    const leagueId = await privateLeagueWithMember(creator.uid, "Team Chat League 1", "TCHAT01");
    await db.asUser(creator.uid);
    const teamId = await insertTeam(leagueId, "Red", "TCHATRED1");
    await db.sql(JOIN_TEAM_CODE, ["TCHATRED1"]);
    await db.sql(POST_TEAM, [leagueId, "team only", teamId]);

    await signUp(db, "tchatoutsider1");
    await db.sql("select join_league_by_code($1)", ["TCHAT01"]);
    expect(
      await db.sql("select 1 from league_messages where league_id = $1 and team_id = $2", [
        leagueId,
        teamId,
      ]),
    ).toHaveLength(0);
  });

  it("lets a team's own member read and post to it", async () => {
    const creator = await signUp(db, "tchatcreator2");
    const leagueId = await privateLeagueWithMember(creator.uid, "Team Chat League 2", "TCHAT02");
    await db.asUser(creator.uid);
    const teamId = await insertTeam(leagueId, "Blue", "TCHATBLU2");
    await db.sql(JOIN_TEAM_CODE, ["TCHATBLU2"]);

    const posted = await db.sql<{ id: string }>(POST_TEAM, [leagueId, "hello team", teamId]);
    expect(posted[0]!.id).toBeTruthy();

    const rows = await db.sql(
      "select 1 from league_messages where league_id = $1 and team_id = $2",
      [leagueId, teamId],
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects posting to a team the caller is not on", async () => {
    const creator = await signUp(db, "tchatcreator3");
    const leagueId = await privateLeagueWithMember(creator.uid, "Team Chat League 3", "TCHAT03");
    await db.asUser(creator.uid);
    const teamId = await insertTeam(leagueId, "Green", "TCHATGRN3");

    await signUp(db, "tchatnonmember3");
    await db.sql("select join_league_by_code($1)", ["TCHAT03"]);
    expect(await db.expectDenied(POST_TEAM, [leagueId, "sneaking in", teamId])).toMatch(
      /not on that team/i,
    );
  });

  it("keeps a general (team_id null) message visible to every league member regardless of team", async () => {
    const creator = await signUp(db, "tchatcreator4");
    const leagueId = await privateLeagueWithMember(creator.uid, "Team Chat League 4", "TCHAT04");
    await db.asUser(creator.uid);
    await insertTeam(leagueId, "Yellow", "TCHATYLW4");
    await db.sql(JOIN_TEAM_CODE, ["TCHATYLW4"]);
    await db.sql(
      `select post_league_message($1, $2) as id`,
      [leagueId, "hello everyone"],
    );

    await signUp(db, "tchatnonmember4");
    await db.sql("select join_league_by_code($1)", ["TCHAT04"]);
    expect(
      await db.sql("select 1 from league_messages where league_id = $1 and team_id is null", [
        leagueId,
      ]),
    ).toHaveLength(1);
  });
});

describe("notifications", () => {
  const POST_MESSAGE = `select post_league_message($1, $2) as id`;
  const UNREAD_COUNTS = `select * from unread_chat_counts($1)`;

  async function privateLeagueWithMember(uid: string, name: string, code: string) {
    const league = await db.sql<{ id: string }>(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, $2, $3, false, $4) returning id`,
      [seasonId, name, code, uid],
    );
    const leagueId = league[0]!.id;
    await db.sql("select create_portfolio_in_league($1, $2, $3)", [leagueId, uid, name]);
    return leagueId;
  }

  it("counts messages posted after the caller's last_read_at, per league", async () => {
    const { uid } = await signUp(db, "notifreader");
    const leagueId = await privateLeagueWithMember(uid, "Notif League", "NOTIF001");

    // No visit row yet — every message posted counts as unread.
    await db.sql(POST_MESSAGE, [leagueId, "first"]);

    // A different sender for each further message, so this isn't gated by
    // post_league_message's own rapid-repost guard (see "league chat" tests)
    // — unread count doesn't care who posted, only when.
    await signUp(db, "notifposter1");
    await db.sql("select join_league_by_code($1)", ["NOTIF001"]);
    await db.sql(POST_MESSAGE, [leagueId, "second"]);

    await db.asUser(uid);
    let rows = await db.sql<{ league_id: string; unread_count: number }>(UNREAD_COUNTS, [[leagueId]]);
    expect(rows).toEqual([{ league_id: leagueId, unread_count: 2 }]);

    // Mark read (as the app does when the league page loads), then post one more.
    await db.sql(
      "insert into league_visits (profile_id, league_id, last_read_at) values ($1, $2, now())",
      [uid, leagueId],
    );

    await signUp(db, "notifposter2");
    await db.sql("select join_league_by_code($1)", ["NOTIF001"]);
    await db.sql(POST_MESSAGE, [leagueId, "third"]);

    await db.asUser(uid);
    rows = await db.sql<{ league_id: string; unread_count: number }>(UNREAD_COUNTS, [[leagueId]]);
    expect(rows).toEqual([{ league_id: leagueId, unread_count: 1 }]);
  });

  it("returns nothing for a league with no unread messages, rather than a zero row", async () => {
    const { uid } = await signUp(db, "notifquiet");
    const leagueId = await privateLeagueWithMember(uid, "Quiet League", "NOTIF002");

    const rows = await db.sql(UNREAD_COUNTS, [[leagueId]]);
    expect(rows).toHaveLength(0);
  });

  it("contributes nothing for a league the caller is not a member of", async () => {
    const owner = await signUp(db, "notifowner3");
    const leagueId = await privateLeagueWithMember(owner.uid, "Outsider Notif League", "NOTIF003");
    await db.sql(POST_MESSAGE, [leagueId, "members only"]);

    await signUp(db, "notifoutsider");
    const rows = await db.sql(UNREAD_COUNTS, [[leagueId]]);
    expect(rows).toHaveLength(0);
  });

  it("lets a user manage their own visit row, but not another user's", async () => {
    const a = await signUp(db, "notifvisitA");
    const leagueId = await privateLeagueWithMember(a.uid, "Visit League", "NOTIF004");

    await db.sql(
      "insert into league_visits (profile_id, league_id, last_seen_rank) values ($1, $2, 3)",
      [a.uid, leagueId],
    );
    expect(
      await db.sql("select last_seen_rank from league_visits where profile_id = $1", [a.uid]),
    ).toEqual([{ last_seen_rank: 3 }]);

    await signUp(db, "notifvisitB");
    await db.sql("select join_league_by_code($1)", ["NOTIF004"]);

    // Cannot see A's row at all.
    expect(
      await db.sql("select 1 from league_visits where profile_id = $1", [a.uid]),
    ).toHaveLength(0);

    // Cannot write A's row either — RLS makes it invisible to the UPDATE,
    // same "zero rows affected is the denial" shape used elsewhere in this file.
    const updated = await db.sql(
      "update league_visits set last_seen_rank = 1 where profile_id = $1 and league_id = $2 returning profile_id",
      [a.uid, leagueId],
    );
    expect(updated).toHaveLength(0);
  });
});

describe("competitions", () => {
  // A portfolio row now *is* a (user, competition) membership — league_members
  // is gone, replaced by portfolios.league_id and create_portfolio_in_league().

  it("gives a competition creator their own independent portfolio in it", async () => {
    // Regression for defect 3, re-shaped: without an insert policy on
    // league_members the league used to end up with no members at all. Under
    // the new model the equivalent failure would be create_portfolio_in_league
    // not actually creating anything — checked directly here.
    const { uid } = await signUp(db, "founder");
    await db.asUser(uid);

    const league = await db.sql<{ id: string }>(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, 'My Club', 'ABC123', false, $2) returning id`,
      [seasonId, uid],
    );
    const created = await db.sql<{ create_portfolio_in_league: string }>(
      "select create_portfolio_in_league($1, $2, $3) as create_portfolio_in_league",
      [league[0]!.id, uid, "founder"],
    );
    const newPortfolioId = created[0]!.create_portfolio_in_league;

    expect(newPortfolioId).toBeTruthy();
    expect(await cashOf(newPortfolioId)).toBe(100_000);
    expect(
      await db.sql("select 1 from portfolios where league_id = $1 and profile_id = $2", [
        league[0]!.id,
        uid,
      ]),
    ).toHaveLength(1);
  });

  it("stops a player creating a portfolio on someone else's behalf", async () => {
    const outsider = await signUp(db, "outsider");
    const { uid } = await signUp(db, "gatekeeper");

    await db.asUser(uid);
    const message = await db.expectDenied(
      "select create_portfolio_in_league($1, $2, $3)",
      [publicLeagueId, outsider.uid, "outsider"],
    );
    expect(message).toMatch(/cannot create a portfolio for another user/i);
  });

  it("does not leak a private league's invite code to a non-member", async () => {
    // Regression for defect 4: `using (true)` handed every private code to
    // anybody holding the public anon key, making the codes decorative.
    // Visibility here comes from created_by, not from having a portfolio in
    // it, so no portfolio needs to exist for this check.
    const owner = await signUp(db, "clubowner");
    await db.asUser(owner.uid);
    await db.sql(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, 'Secret Club', 'SECRET', false, $2)`,
      [seasonId, owner.uid],
    );

    const nosy = await signUp(db, "nosy");
    await db.asUser(nosy.uid);
    expect(await db.sql("select code from leagues where code = 'SECRET'")).toHaveLength(0);

    // The public league stays visible to everyone, which the leaderboard needs.
    expect(
      await db.sql("select code from leagues where code = 'SEASON1'"),
    ).toHaveLength(1);
  });

  it("previews a league by code, then joins it, without ever exposing the table", async () => {
    const owner = await signUp(db, "host");
    await db.asUser(owner.uid);
    await db.sql(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, 'Invite Only', 'JOINME', false, $2)`,
      [seasonId, owner.uid],
    );

    const guest = await signUp(db, "guest");
    await db.asUser(guest.uid);

    // Cannot read the row...
    expect(await db.sql("select 1 from leagues where code = 'JOINME'")).toHaveLength(0);

    // ...but holding the code is enough to see what it is and join it.
    const preview = await db.sql<{ name: string; member_count: number }>(
      "select name, member_count::int as member_count from league_preview($1)",
      ["joinme"], // case-insensitive, as the invite link may be lowercased
    );
    expect(preview[0]!.name).toBe("Invite Only");
    expect(preview[0]!.member_count).toBe(0); // the owner has no portfolio there yet either

    await db.sql("select join_league_by_code($1)", ["joinme"]);

    // Now has a portfolio there, so the row becomes readable.
    expect(await db.sql("select 1 from leagues where code = 'JOINME'")).toHaveLength(1);
    const members = await db.sql(
      `select 1 from portfolios p join leagues l on l.id = p.league_id
        where l.code = 'JOINME' and p.profile_id = $1`,
      [guest.uid],
    );
    expect(members).toHaveLength(1);
  });

  it("rejects a bad invite code", async () => {
    const { uid } = await signUp(db, "lost");
    await db.asUser(uid);
    expect(await db.expectDenied("select join_league_by_code($1)", ["NOPE99"])).toMatch(
      /No league with that code/,
    );
  });

  it("is idempotent when joining a league twice", async () => {
    const { uid } = await signUp(db, "eager");
    await db.asUser(uid);
    await db.sql("select join_league_by_code($1)", ["SEASON1"]);
    await db.sql("select join_league_by_code($1)", ["SEASON1"]);

    const rows = await db.sql(
      "select id from portfolios where league_id = $1 and profile_id = $2",
      [publicLeagueId, uid],
    );
    // Just the flagship portfolio from signup — "joining" it again is a no-op,
    // not a second portfolio.
    expect(rows).toHaveLength(1);
  });

  it("gives a second competition its own independent portfolio, untouched by the first", async () => {
    const { uid, portfolioId: flagshipId } = await signUp(db, "multiplayer");
    await db.asUser(uid);

    const league = await db.sql<{ id: string }>(
      `insert into leagues (season_id, name, code, is_public, created_by)
       values ($1, 'Second Club', 'SECOND1', false, $2) returning id`,
      [seasonId, uid],
    );
    await db.sql("select join_league_by_code($1)", ["SECOND1"]);
    const secondPortfolioRows = await db.sql<{ id: string }>(
      "select id from portfolios where league_id = $1 and profile_id = $2",
      [league[0]!.id, uid],
    );
    const secondId = secondPortfolioRows[0]!.id;

    expect(secondId).not.toBe(flagshipId);
    expect(await cashOf(secondId)).toBe(100_000);

    // Trading in the second competition must not touch the flagship's cash.
    await db.sql(TRADE, [secondId, "AAPL", "buy", 10, 200]);
    expect(await cashOf(secondId)).toBe(98_000);
    expect(await cashOf(flagshipId)).toBe(100_000);
    expect(await holdingOf(flagshipId, "AAPL")).toBeNull();
  });

  it("allows a second AI portfolio in the same season, as long as it's a different league", async () => {
    // Regression: one_special_per_season used to key on (season_id,
    // owner_type) alone, allowing exactly one 'ai' portfolio per season full
    // stop — which would make "1v1 the AI" duels impossible, since every duel
    // needs its own fresh AI portfolio alongside the flagship's. Re-keyed to
    // (league_id, owner_type) below, so this must now succeed...
    await db.asSuperuser();
    const duel = await db.sql<{ id: string }>(
      `insert into leagues (season_id, name, code, is_public)
       values ($1, '1v1 the AI', 'DUEL01', false) returning id`,
      [seasonId],
    );
    const duelAi = await db.sql<{ id: string }>(
      `insert into portfolios (season_id, league_id, owner_type, display_name, cash, starting_balance)
       values ($1, $2, 'ai', 'StockOff AI', 100000, 100000) returning id`,
      [seasonId, duel[0]!.id],
    );
    expect(duelAi[0]!.id).toBeTruthy();

    // ...while a second AI in the very same league must still be rejected —
    // the constraint still defends against that, just scoped differently.
    const message = await db.expectDenied(
      `insert into portfolios (season_id, league_id, owner_type, display_name, cash, starting_balance)
       values ($1, $2, 'ai', 'Duplicate AI', 100000, 100000)`,
      [seasonId, duel[0]!.id],
    );
    expect(message).toMatch(/duplicate|unique|one_special_per_league/i);
  });
});

describe("public reads", () => {
  it("lets an anonymous visitor read the leaderboard", async () => {
    // The landing page and public leaderboard render without a session.
    const { portfolioId } = await signUp(db, "onboard");
    await db.sql(TRADE, [portfolioId, "AAPL", "buy", 5, 200]);

    await db.asAnon();
    const rows = await db.sql<{ display_name: string }>(
      `select display_name from portfolios
        where league_id = $1 and display_name = 'onboard'`,
      [publicLeagueId],
    );
    expect(rows).toHaveLength(1);
    expect(await db.sql("select symbol from price_cache")).not.toHaveLength(0);
    expect(
      await db.sql("select 1 from holdings where portfolio_id = $1", [portfolioId]),
    ).toHaveLength(1);
  });

  it("keeps auth emails out of public reach", async () => {
    await db.asAnon();
    // profiles carries no email column at all — the only copy lives in auth.users.
    const cols = await db.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain("email");
  });
});
