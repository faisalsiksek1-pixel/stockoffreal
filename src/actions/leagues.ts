"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AI_NOTE, AI_PICKS } from "@/lib/ai-strategy";
import { marketData } from "@/lib/market";
import { createAdminClient, createClient } from "@/lib/supabase/server";

export type LeagueResult =
  | { ok: true; code: string; id: string; teamsRequested?: number; teamsCreated?: number }
  | { ok: false; error: string };

const NameSchema = z.string().trim().min(3, "Give the league a name of at least 3 characters.").max(40);
const TeamNameSchema = z.string().trim().min(1, "Team name cannot be empty.").max(40, "Team name is too long.");

/** Ambiguous characters (0/O, 1/I) are excluded so codes survive being read aloud. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** Same retry-on-collision shape as the league code loops below, extracted
 *  since both createLeague (bulk, at setup) and createTeam (one at a time,
 *  later) need it. RLS alone authorizes the insert — see
 *  0010_teams.sql's "teams insertable by league creator" policy. */
async function insertTeamWithRetry(
  supabase: Awaited<ReturnType<typeof createClient>>,
  leagueId: string,
  name: string,
  creatorId: string,
): Promise<{ id: string; code: string } | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    const { data, error } = await supabase
      .from("teams")
      .insert({ league_id: leagueId, name, code, created_by: creatorId })
      .select("id, code")
      .maybeSingle();
    if (data) return { id: data.id as string, code: data.code as string };
    if (error && !error.message.includes("duplicate")) return null;
  }
  return null;
}

export async function createLeague(formData: FormData): Promise<LeagueResult> {
  const parsed = NameSchema.safeParse(formData.get("name"));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid name." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data: season } = await supabase
    .from("seasons")
    .select("id")
    .eq("is_active", true)
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!season) return { ok: false, error: "No active season." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { ok: false, error: "You do not have a profile yet." };

  // Retry on the small chance of a code collision rather than failing the user.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    const { data, error } = await supabase
      .from("leagues")
      .insert({
        name: parsed.data,
        code,
        season_id: season.id,
        is_public: false,
        created_by: user.id,
      })
      .select("id, code")
      .maybeSingle();

    if (data) {
      // Checked, not fired and forgotten: if this fails the creator is not in
      // their own competition, which looks like it simply vanished.
      const { error: joinError } = await supabase.rpc("create_portfolio_in_league", {
        p_league_id: data.id,
        p_uid: user.id,
        p_display_name: profile.username,
      });
      if (joinError) {
        return { ok: false, error: `League created but could not join it: ${joinError.message}` };
      }

      // Best-effort, not atomic: a team name that can't get a unique code
      // after 5 attempts (astronomically unlikely) or otherwise fails does
      // not roll back the league itself, which already succeeded. The
      // creator can add any missing teams afterward from the league page.
      const teamNames = formData
        .getAll("teamName")
        .map(String)
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .slice(0, 10)
        .filter((n) => TeamNameSchema.safeParse(n).success);

      let teamsCreated = 0;
      for (const name of teamNames) {
        if (await insertTeamWithRetry(supabase, data.id as string, name, user.id)) teamsCreated++;
      }

      revalidatePath("/leagues");
      return {
        ok: true,
        code: data.code as string,
        id: data.id as string,
        teamsRequested: teamNames.length,
        teamsCreated,
      };
    }
    if (error && !error.message.includes("duplicate")) {
      return { ok: false, error: error.message };
    }
  }
  return { ok: false, error: "Could not generate a unique code. Try again." };
}

export async function joinLeague(formData: FormData): Promise<LeagueResult> {
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  if (code.length < 4) return { ok: false, error: "Enter the invite code." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("join_league_by_code", { p_code: code });

  if (error) return { ok: false, error: error.message.replace(/^.*?:\s*/, "") };

  revalidatePath("/leagues");
  return { ok: true, code, id: data as string };
}

export type TeamResult = { ok: true; id: string; code: string } | { ok: false; error: string };

/** Adds a team to an existing league — the same insert createLeague does in
 *  bulk at setup time, for the creator to use afterward if they forgot one
 *  or want more. RLS (not this action) checks that the caller is the
 *  league's creator. */
export async function createTeam(formData: FormData): Promise<TeamResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const leagueId = String(formData.get("leagueId") ?? "");
  const leagueCode = String(formData.get("leagueCode") ?? "");
  const parsed = TeamNameSchema.safeParse(formData.get("name"));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid name." };
  }

  const result = await insertTeamWithRetry(supabase, leagueId, parsed.data, user.id);
  if (!result) return { ok: false, error: "Could not create the team. Try again." };

  revalidatePath(`/leagues/${leagueCode}`);
  return { ok: true, id: result.id, code: result.code };
}

/** A team code is a one-step invite: joins the league (if needed) and
 *  assigns the joiner to that team. Returns the same shape joinLeague does
 *  so the form can reuse its exact redirect — the caller only had a team
 *  code, not the league's own, hence join_team_by_code returning it. */
export async function joinTeam(formData: FormData): Promise<LeagueResult> {
  const code = String(formData.get("code") ?? "").trim();
  if (code.length < 4) return { ok: false, error: "Enter the team code." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("join_team_by_code", { p_code: code });
  if (error) return { ok: false, error: error.message.replace(/^.*?:\s*/, "") };

  const result = data as { league_id: string; league_code: string };
  revalidatePath("/leagues");
  return { ok: true, code: result.league_code, id: result.league_id };
}

/**
 * Creates a private competition that is just the caller and a fresh AI
 * portfolio — one_special_per_league (not per_season) is what allows this:
 * every duel gets its own 'ai'-owner_type portfolio, scoped to its own
 * league, alongside the flagship's.
 *
 * The AI's book is a one-time fixed allocation, filled through execute_trade
 * exactly like the seed script fills the flagship AI, using the same
 * AI_PICKS — it does not trade further after this.
 */
export async function startAiDuel(): Promise<LeagueResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return { ok: false, error: "You do not have a profile yet." };

  const { data: season } = await supabase
    .from("seasons")
    .select("id, starting_balance")
    .eq("is_active", true)
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!season) return { ok: false, error: "No active season." };

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `AI${makeCode(5)}`;
    const { data: league, error } = await supabase
      .from("leagues")
      .insert({
        name: "1v1 the AI",
        code,
        season_id: season.id,
        is_public: false,
        created_by: user.id,
      })
      .select("id, code")
      .maybeSingle();

    if (league) {
      const { error: joinError } = await supabase.rpc("create_portfolio_in_league", {
        p_league_id: league.id,
        p_uid: user.id,
        p_display_name: profile.username,
      });
      if (joinError) {
        return { ok: false, error: `Duel created but could not join it: ${joinError.message}` };
      }

      // The AI's portfolio is created with the service-role client: users
      // hold no insert policy on portfolios (by design — cash only ever
      // moves through execute_trade/create_portfolio_in_league), and this
      // portfolio has no profile_id of its own for that RPC's ownership
      // check to authorize.
      const admin = createAdminClient();
      const { data: aiPortfolio, error: aiError } = await admin
        .from("portfolios")
        .insert({
          season_id: season.id,
          league_id: league.id,
          owner_type: "ai",
          display_name: "StockOff AI",
          cash: season.starting_balance,
          starting_balance: season.starting_balance,
          strategy_note: AI_NOTE,
        })
        .select("id")
        .single();
      if (aiError || !aiPortfolio) {
        return { ok: false, error: `Duel created but the AI could not join: ${aiError?.message}` };
      }

      const quotes = await marketData().getQuotes(AI_PICKS.map(([symbol]) => symbol));
      for (const [symbol, pct] of AI_PICKS) {
        const price = quotes.get(symbol)?.price;
        if (!price) continue;
        const shares = Math.floor(((season.starting_balance * (pct / 100)) / price) * 1e6) / 1e6;
        if (shares <= 0) continue;
        await admin.rpc("execute_trade", {
          p_portfolio_id: aiPortfolio.id,
          p_symbol: symbol,
          p_side: "buy",
          p_shares: shares,
          p_price: price,
        });
      }

      revalidatePath("/leagues");
      return { ok: true, code: league.code as string, id: league.id as string };
    }
    if (error && !error.message.includes("duplicate")) {
      return { ok: false, error: error.message };
    }
  }
  return { ok: false, error: "Could not generate a unique code. Try again." };
}
