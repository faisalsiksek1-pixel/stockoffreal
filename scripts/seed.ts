/**
 * Seed the database with a fresh Season One: prices, the season, the
 * flagship "StockOff League" competition, and its AI opponent.
 *
 *   npm run seed
 *
 * Idempotent: re-running wipes the seeded season and rebuilds it, so it is safe
 * to run repeatedly while developing. No demo user accounts are created —
 * the leaderboard starts empty, ready for real signups.
 */

import { createClient } from "@supabase/supabase-js";

import { AI_NOTE, AI_PICKS } from "../src/lib/ai-strategy";
import { INSTRUMENTS } from "../src/lib/market/instruments";
import { MockProvider } from "../src/lib/market/mock";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !SERVICE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Copy .env.example to .env.local and fill them in, then run:\n" +
      "  npm run setup\n" +
      "which reads .env.local itself and seeds once the schema is applied.",
  );
  process.exit(1);
}

const db = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SEASON_SLUG = "season-one";
const STARTING = 100_000;

const market = new MockProvider();

async function main() {
  console.log("Seeding StockOff…\n");

  // ---- prices -------------------------------------------------------------
  const quotes = await market.getQuotes(INSTRUMENTS.map((i) => i.symbol));
  await db.from("price_cache").upsert(
    [...quotes.values()].map((q) => ({
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      prev_close: q.prevClose,
      updated_at: new Date().toISOString(),
    })),
  );
  console.log(`  ${quotes.size} instruments cached`);

  // ---- clean slate --------------------------------------------------------
  const { data: existing } = await db
    .from("seasons")
    .select("id")
    .eq("slug", SEASON_SLUG)
    .maybeSingle();

  if (existing) {
    // Cascades wipe portfolios, holdings, trades, leagues and memberships.
    await db.from("seasons").delete().eq("id", existing.id);
    console.log("  removed previous season-one data");
  }

  const { data: seasonRow, error: seasonError } = await db
    .from("seasons")
    .insert({
      name: "Season One",
      slug: SEASON_SLUG,
      starting_balance: STARTING,
      is_active: true,
    })
    .select("id")
    .single();
  if (seasonError || !seasonRow) throw seasonError ?? new Error("season insert failed");
  // Narrowed to non-null here so the nested helper below does not need a
  // redundant check on every call.
  const season: { id: string } = seasonRow;
  console.log("  season created");

  // ---- leagues ------------------------------------------------------------
  const { data: publicLeague } = await db
    .from("leagues")
    .insert({
      season_id: season.id,
      name: "StockOff League",
      code: "SEASON1",
      is_public: true,
    })
    .select("id")
    .single();
  if (!publicLeague) throw new Error("public league insert failed");
  console.log("  flagship competition created");

  /** Create a portfolio scoped to one competition and fill its holdings via
   *  real trades. */
  async function buildPortfolio(opts: {
    ownerType: "user" | "ai" | "human" | "benchmark";
    displayName: string;
    profileId?: string;
    picks: [string, number][];
    note?: string;
    leagueId: string;
  }) {
    const { data: portfolio, error } = await db
      .from("portfolios")
      .insert({
        season_id: season.id,
        league_id: opts.leagueId,
        owner_type: opts.ownerType,
        profile_id: opts.profileId ?? null,
        display_name: opts.displayName,
        cash: STARTING,
        starting_balance: STARTING,
        strategy_note: opts.note ?? null,
      })
      .select("id")
      .single();
    if (error || !portfolio) throw error ?? new Error("portfolio insert failed");

    // Going through execute_trade means seeded books obey exactly the same rules
    // as player books — including the cash check, so an over-large pick fails
    // loudly here rather than creating an impossible portfolio.
    for (const [symbol, percent] of opts.picks) {
      const price = quotes.get(symbol)?.price;
      if (!price) continue;

      // Seeded books fill at the PREVIOUS close, not today's price. Filling at
      // today's price would value the holding at exactly what was paid for
      // it, so the AI would show 0.00% return until prices next moved.
      // Buying at yesterday's close means today's move is already reflected.
      const fillPrice = quotes.get(symbol)?.prevClose ?? price;
      const shares =
        Math.floor(((STARTING * (percent / 100)) / fillPrice) * 1e6) / 1e6;
      if (shares <= 0) continue;
      const { error: tradeError } = await db.rpc("execute_trade", {
        p_portfolio_id: portfolio.id,
        p_symbol: symbol,
        p_side: "buy",
        p_shares: shares,
        p_price: fillPrice,
        // Seeded books are unleveraged — the picks/weights above are already
        // sized against plain starting cash.
        p_leverage: 1,
      });
      if (tradeError) {
        // With weights summing under 100% this should not happen; if it does,
        // the allocation is wrong rather than merely unlucky.
        console.warn(
          `    FAILED ${percent}% ${symbol} (${shares} sh): ${tradeError.message}`,
        );
      }
    }

    return portfolio.id;
  }

  // ---- special competitors --------------------------------------------------
  // Only ever built for the flagship competition — a private one, or a "1v1
  // the AI" duel, gets its own fresh AI portfolio via startAiDuel() instead.
  await buildPortfolio({
    ownerType: "ai",
    displayName: "StockOff AI",
    picks: AI_PICKS,
    note: AI_NOTE,
    leagueId: publicLeague.id,
  });

  // The benchmark holds SPY only: its value then tracks the index's percentage
  // return from the same $100,000 start, using the identical price path as
  // everyone else.
  await buildPortfolio({
    ownerType: "benchmark",
    displayName: "S&P 500",
    // Fully invested, so its value tracks the index's percentage return exactly.
    picks: [["SPY", 100]],
    note: "Buys and holds an S&P 500 ETF for the whole season. The passive baseline.",
    leagueId: publicLeague.id,
  });
  console.log("  AI and S&P 500 portfolios built");

  console.log("\nDone.\n");
  console.log("Public league code: SEASON1");
  console.log(
    "\nTo make yourself an admin, set ADMIN_EMAILS in .env.local before signing up,\n" +
      "or run: update profiles set is_admin = true where username = 'your_name';",
  );
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message ?? err);
  process.exit(1);
});
