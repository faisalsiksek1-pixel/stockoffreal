"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveCompetition } from "@/lib/competition";
import { marketData } from "@/lib/market";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_LEVERAGE, LEVERAGE_OPTIONS } from "@/lib/trade-rules";

/**
 * Limit order placement and cancellation.
 *
 * Both actions do the bare minimum here — schema validation and a symbol
 * lookup — and let place_limit_order / cancel_limit_order (SECURITY DEFINER,
 * see 0007_pending_orders.sql) own the actual rules and the ownership check,
 * the same split placeOrder uses with execute_trade.
 */

const PlaceSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z.\-]{1,10}$/, "That does not look like a ticker."),
    side: z.enum(["buy", "sell"]),
    mode: z.enum(["shares", "dollars"]),
    quantity: z.coerce.number().positive("Enter an amount greater than zero."),
    targetPrice: z.coerce.number().positive("Enter a target price greater than zero."),
    // Only meaningful for a buy (see place_limit_order); accepted for sell
    // too so the form never has to omit it.
    leverage: z.coerce
      .number()
      .refine((v) => (LEVERAGE_OPTIONS as readonly number[]).includes(v), "Choose a valid leverage.")
      .default(DEFAULT_LEVERAGE),
  })
  .strict();

export type OrderActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function placeLimitOrder(formData: FormData): Promise<OrderActionResult> {
  const parsed = PlaceSchema.safeParse({
    symbol: formData.get("symbol"),
    side: formData.get("side"),
    mode: formData.get("mode"),
    quantity: formData.get("quantity"),
    targetPrice: formData.get("targetPrice"),
    // formData.get returns null, not undefined, when absent, and zod's
    // .default() only substitutes for undefined.
    leverage: formData.get("leverage") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid order." };
  }
  const { symbol, side, mode, quantity, targetPrice, leverage } = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in to trade." };

  const resolved = await resolveCompetition();
  if (!resolved) return { ok: false, error: "You do not have a portfolio yet." };

  const { data: portfolio } = await supabase
    .from("portfolios")
    .select("id")
    .eq("profile_id", user.id)
    .eq("league_id", resolved.leagueId)
    .maybeSingle();
  if (!portfolio) return { ok: false, error: "You do not have a portfolio yet." };

  // Confirms the symbol is actually tradeable before it becomes a standing
  // order — same check placeOrder does for an immediate one.
  const quotes = await marketData().getQuotes([symbol]);
  if (!quotes.has(symbol)) {
    return { ok: false, error: `${symbol} is not available to trade.` };
  }

  const { error } = await supabase.rpc("place_limit_order", {
    p_portfolio_id: portfolio.id,
    p_symbol: symbol,
    p_side: side,
    p_mode: mode,
    p_quantity: quantity,
    p_target_price: targetPrice,
    p_leverage: leverage,
  });
  if (error) return { ok: false, error: error.message.replace(/^.*?:\s*/, "") };

  revalidatePath("/trade");

  const verb = side === "buy" ? "Buy" : "Sell";
  return {
    ok: true,
    message: `${verb} order placed: ${quantity} ${mode === "dollars" ? "$" : "shares of"} ${symbol} at $${targetPrice.toFixed(2)}.`,
  };
}

export async function cancelPendingOrder(orderId: string): Promise<OrderActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in to trade." };

  const { error } = await supabase.rpc("cancel_limit_order", { p_order_id: orderId });
  if (error) return { ok: false, error: error.message.replace(/^.*?:\s*/, "") };

  revalidatePath("/trade");
  return { ok: true, message: "Order cancelled." };
}
