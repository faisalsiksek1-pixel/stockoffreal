/**
 * One-off: adds the S&P 500 benchmark portfolio to the flagship competition
 * of the currently active season, without touching anything else.
 *
 *   npx tsx scripts/add-benchmark.ts
 *
 * For a live project where re-running `npm run seed` would wipe real player
 * data — this only inserts one portfolio (and buys it into SPY), it never
 * deletes a season. Idempotent: does nothing if the flagship already has a
 * benchmark portfolio.
 *
 * Prices come from the app's own market provider (see src/lib/market), not
 * from price_cache — with MARKET_DATA_PROVIDER=mock, prices are generated
 * deterministically and are not read from that table, so this asks the same
 * code path the app itself uses rather than guessing at a price.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";

// tsx does not load .env.local on its own — scripts/setup.ts normally reads
// it and passes the vars into seed.ts's child process, but this script is
// meant to be run directly, so it loads the file itself.
const ENV_FILE = join(__dirname, "..", ".env.local");
try {
  // \r?\n, not just \n: a CRLF file otherwise leaves a trailing \r stuck to
  // every line but the last, which stops the $ anchor below from matching —
  // every var except the final line in the file would silently fail to load.
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!(key! in process.env)) {
      process.env[key!] = rawValue!.trim().replace(/^["']|["']$/g, "");
    }
  }
} catch {
  console.error(`Could not read ${ENV_FILE}.`);
  process.exit(1);
}

import { marketData } from "../src/lib/market";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STARTING = 100_000;

if (!URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}

const db = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: season, error: seasonError } = await db
    .from("seasons")
    .select("id")
    .eq("is_active", true)
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (seasonError || !season) throw seasonError ?? new Error("No active season.");

  const { data: league, error: leagueError } = await db
    .from("leagues")
    .select("id, name")
    .eq("season_id", season.id)
    .eq("is_public", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (leagueError || !league) throw leagueError ?? new Error("No flagship competition found.");

  const { data: existing } = await db
    .from("portfolios")
    .select("id")
    .eq("league_id", league.id)
    .eq("owner_type", "benchmark")
    .maybeSingle();
  if (existing) {
    console.log(`"${league.name}" already has a benchmark portfolio — nothing to do.`);
    return;
  }

  const quotes = await marketData().getQuotes(["SPY"]);
  const quote = quotes.get("SPY");
  if (!quote) throw new Error("No price available for SPY.");

  const { data: portfolio, error: portfolioError } = await db
    .from("portfolios")
    .insert({
      season_id: season.id,
      league_id: league.id,
      owner_type: "benchmark",
      display_name: "S&P 500",
      cash: STARTING,
      starting_balance: STARTING,
      strategy_note:
        "Buys and holds an S&P 500 ETF for the whole season. The passive baseline.",
    })
    .select("id")
    .single();
  if (portfolioError || !portfolio) throw portfolioError ?? new Error("portfolio insert failed");

  // Fully invested, at today's price, filled through execute_trade so it
  // obeys the same cash check every other trade does.
  const shares = Math.floor((STARTING / quote.price) * 1e6) / 1e6;
  const { error: tradeError } = await db.rpc("execute_trade", {
    p_portfolio_id: portfolio.id,
    p_symbol: "SPY",
    p_side: "buy",
    p_shares: shares,
    p_price: quote.price,
  });
  if (tradeError) throw tradeError;

  console.log(`Added the S&P 500 benchmark to "${league.name}": ${shares} shares of SPY at $${quote.price.toFixed(2)}.`);
}

main().catch((err) => {
  console.error("Failed:", err.message ?? err);
  process.exit(1);
});
