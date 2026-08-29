"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveCompetition } from "@/lib/competition";
import { marketData } from "@/lib/market";
import { shortLiability } from "@/lib/portfolio";
import { DEFAULT_LEVERAGE, LEVERAGE_OPTIONS, resolveOrder } from "@/lib/trade-rules";
import { createClient } from "@/lib/supabase/server";

/**
 * Order submission.
 *
 * Two rules hold here and are the reason this is a server action rather than a
 * client-side write:
 *
 * 1. The price is looked up on the server. The client sends a symbol, a side and
 *    a quantity — never a price. A client-supplied price would let anyone buy at
 *    $0.01.
 * 2. Execution happens inside the execute_trade SQL function, which takes a row
 *    lock on the portfolio. The pre-check below is only there to produce a nicer
 *    error message; the database is what actually guarantees a user cannot
 *    overspend when two requests arrive at once.
 */

const OrderSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z.\-]{1,10}$/, "That does not look like a ticker."),
    side: z.enum(["buy", "sell", "short", "cover"]),
    mode: z.enum(["shares", "dollars"]),
    quantity: z.coerce.number().positive("Enter an amount greater than zero."),
    // Only buy/short spend leveraged buying power (see resolveOrder), but the
    // field is accepted for every side so the form never has to omit it.
    // Defaults to the pre-selector multiplier for callers that don't send one.
    leverage: z.coerce
      .number()
      .refine((v) => (LEVERAGE_OPTIONS as readonly number[]).includes(v), "Choose a valid leverage.")
      .default(DEFAULT_LEVERAGE),
  })
  .strict();

export type OrderResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function placeOrder(formData: FormData): Promise<OrderResult> {
  const parsed = OrderSchema.safeParse({
    symbol: formData.get("symbol"),
    side: formData.get("side"),
    mode: formData.get("mode"),
    quantity: formData.get("quantity"),
    // formData.get returns null, not undefined, when absent — and zod's
    // .default() only substitutes for undefined — so a missing field has to
    // be normalised here rather than left for the schema to fall back on.
    leverage: formData.get("leverage") ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid order." };
  }
  const { symbol, side, mode, quantity, leverage } = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in to trade." };

  // Each competition is an independent portfolio, so this order has to be
  // placed against whichever one the trade page currently has selected —
  // same cookie the dashboard switcher writes.
  const resolved = await resolveCompetition();
  if (!resolved) return { ok: false, error: "You do not have a portfolio yet." };

  const { data: portfolio } = await supabase
    .from("portfolios")
    .select("id, cash")
    .eq("profile_id", user.id)
    .eq("league_id", resolved.leagueId)
    .maybeSingle();
  if (!portfolio) return { ok: false, error: "You do not have a portfolio yet." };

  // Server-side price lookup. This is the price the order executes at.
  const quotes = await marketData().getQuotes([symbol]);
  const quote = quotes.get(symbol);
  if (!quote) {
    return { ok: false, error: `${symbol} is not available to trade.` };
  }

  const { data: holdings } = await supabase
    .from("holdings")
    .select("symbol, shares, avg_cost")
    .eq("portfolio_id", portfolio.id);

  const existing = holdings?.find((h) => h.symbol === symbol);
  const cash = Number(portfolio.cash);
  const liability = shortLiability(
    (holdings ?? []).map((h) => ({
      symbol: h.symbol as string,
      shares: Number(h.shares),
      avgCost: Number(h.avg_cost),
    })),
  );
  const availableCash = cash - liability;

  const check = resolveOrder(
    {
      symbol,
      side,
      ...(mode === "shares" ? { shares: quantity } : { dollars: quantity }),
    },
    quote.price,
    cash,
    availableCash,
    liability,
    existing
      ? {
          symbol: existing.symbol as string,
          shares: Number(existing.shares),
          avgCost: Number(existing.avg_cost),
        }
      : undefined,
    leverage,
  );
  if (!check.ok) return { ok: false, error: check.error };

  const { error } = await supabase.rpc("execute_trade", {
    p_portfolio_id: portfolio.id,
    p_symbol: symbol,
    p_side: side,
    p_shares: check.shares,
    p_price: quote.price,
    p_leverage: leverage,
  });

  if (error) {
    // The SQL function raises human-readable messages for rule violations, so
    // surfacing it directly is more useful than a generic failure.
    return { ok: false, error: error.message.replace(/^.*?:\s*/, "") };
  }

  revalidatePath("/dashboard");
  revalidatePath("/portfolio");
  revalidatePath("/trade");
  revalidatePath("/leaderboard");

  const verb = { buy: "Bought", sell: "Sold", short: "Shorted", cover: "Covered" }[side];
  return {
    ok: true,
    message: `${verb} ${check.shares} ${symbol} at $${quote.price.toFixed(2)} for $${check.amount.toFixed(2)} total.`,
  };
}
