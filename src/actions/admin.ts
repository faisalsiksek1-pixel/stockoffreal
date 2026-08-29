"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { marketData } from "@/lib/market";
import { createAdminClient, createClient } from "@/lib/supabase/server";

/**
 * Admin actions.
 *
 * Every function starts with requireAdmin(), which checks the caller's profile
 * server-side. The service-role client is only constructed *after* that check
 * passes — it bypasses RLS entirely, so reaching for it before verifying the
 * caller would hand any signed-in user full database access.
 */

export type AdminResult = { ok: true; message: string } | { ok: false; error: string };

async function requireAdmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_admin) return { ok: false, error: "Admin access required." };
  return { ok: true };
}

const SpecialTradeSchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z.\-]{1,10}$/),
  side: z.enum(["buy", "sell", "short", "cover"]),
  shares: z.coerce.number().positive(),
});

/** Place a trade for the flagship competition's AI portfolio, using the same
 *  execution path as players so its book cannot diverge from the rules.
 *  Scoped to the flagship specifically, not just owner_type/season: since
 *  "1v1 the AI" duels each get their own 'ai' portfolio, a season can now
 *  have several — one_special_per_league (not per_season) is what allows
 *  that, so season alone is no longer enough to identify "the" AI here. */
export async function adminTrade(formData: FormData): Promise<AdminResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = SpecialTradeSchema.safeParse({
    symbol: formData.get("symbol"),
    side: formData.get("side"),
    shares: formData.get("shares"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid trade." };
  }
  const { symbol, side, shares } = parsed.data;

  const admin = createAdminClient();
  const { data: season } = await admin
    .from("seasons")
    .select("id")
    .eq("is_active", true)
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!season) return { ok: false, error: "No active season." };

  const { data: flagship } = await admin
    .from("leagues")
    .select("id")
    .eq("season_id", season.id)
    .eq("is_public", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!flagship) return { ok: false, error: "No flagship competition found." };

  const { data: portfolio } = await admin
    .from("portfolios")
    .select("id")
    .eq("owner_type", "ai")
    .eq("league_id", flagship.id)
    .maybeSingle();
  if (!portfolio) return { ok: false, error: "No AI portfolio found." };

  const quotes = await marketData().getQuotes([symbol]);
  const quote = quotes.get(symbol);
  if (!quote) return { ok: false, error: `No price for ${symbol}.` };

  const { error } = await admin.rpc("execute_trade", {
    p_portfolio_id: portfolio.id,
    p_symbol: symbol,
    p_side: side,
    p_shares: shares,
    p_price: quote.price,
    // Admin corrections rebalance the AI/benchmark books directly — no
    // leverage selector applies here, so this is the unleveraged baseline.
    p_leverage: 1,
  });
  if (error) return { ok: false, error: error.message.replace(/^.*?:\s*/, "") };

  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/");
  return {
    ok: true,
    message: `AI: ${side} ${shares} ${symbol} at $${quote.price.toFixed(2)}.`,
  };
}

export async function adminRenameUser(formData: FormData): Promise<AdminResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const profileId = String(formData.get("profileId") ?? "");
  const username = String(formData.get("username") ?? "").trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return { ok: false, error: "Username must be 3–20 letters, numbers or underscores." };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ username })
    .eq("id", profileId);
  if (error) return { ok: false, error: error.message };

  // The portfolio display name is what appears on the leaderboard, so it has to
  // move with the username or the board would keep showing the old one.
  await admin
    .from("portfolios")
    .update({ display_name: username })
    .eq("profile_id", profileId);

  revalidatePath("/admin");
  revalidatePath("/leaderboard");
  return { ok: true, message: `Renamed to ${username}.` };
}

export async function adminEndSeason(): Promise<AdminResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const admin = createAdminClient();
  const { error } = await admin
    .from("seasons")
    .update({ is_active: false, ends_at: new Date().toISOString() })
    .eq("is_active", true);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin");
  return { ok: true, message: "Season closed. Create a new one to start the next." };
}

const NewSeasonSchema = z.object({
  name: z.string().trim().min(3).max(60),
  slug: z.string().trim().regex(/^[a-z0-9-]{3,40}$/, "Slug: lowercase letters, numbers, hyphens."),
});

export async function adminCreateSeason(formData: FormData): Promise<AdminResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = NewSeasonSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid season." };
  }

  const admin = createAdminClient();
  // Only one season may be active at a time — bootstrap_new_user picks the
  // active one, so two would make signup nondeterministic.
  await admin.from("seasons").update({ is_active: false }).eq("is_active", true);

  const { error } = await admin.from("seasons").insert({
    name: parsed.data.name,
    slug: parsed.data.slug,
    is_active: true,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin");
  return { ok: true, message: `Season "${parsed.data.name}" is now active.` };
}

/** Reset every portfolio in the active season back to a clean $100,000. */
export async function adminResetBalances(): Promise<AdminResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const admin = createAdminClient();
  const { data: season } = await admin
    .from("seasons")
    .select("id, starting_balance")
    .eq("is_active", true)
    .maybeSingle();
  if (!season) return { ok: false, error: "No active season." };

  const { data: portfolios } = await admin
    .from("portfolios")
    .select("id")
    .eq("season_id", season.id);

  const ids = (portfolios ?? []).map((p) => p.id as string);
  if (ids.length) {
    await admin.from("holdings").delete().in("portfolio_id", ids);
    await admin.from("trades").delete().in("portfolio_id", ids);
    await admin
      .from("portfolios")
      .update({ cash: season.starting_balance })
      .in("id", ids);
  }

  revalidatePath("/admin");
  revalidatePath("/leaderboard");
  return { ok: true, message: `Reset ${ids.length} portfolio(s) to starting balance.` };
}
