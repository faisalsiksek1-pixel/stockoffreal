import { marketData } from "@/lib/market";
import { createClient } from "@/lib/supabase/server";
import { rankPortfolios, valuePortfolio, type PortfolioInput } from "@/lib/portfolio";
import type {
  ChatMessage,
  LeaderboardRow,
  MyTeam,
  OwnerType,
  PendingOrder,
  Quote,
  Team,
  Trade,
  TradeSide,
  ValuedPortfolio,
} from "@/lib/types";

/**
 * Read-side data access. Everything that needs a valued portfolio or a
 * leaderboard comes through here, so pages stay thin and there is exactly one
 * place where rows become domain objects.
 */

interface PortfolioRow {
  id: string;
  owner_type: "user" | "ai" | "human" | "benchmark";
  display_name: string;
  cash: string | number;
  starting_balance: string | number;
  profile_id: string | null;
  team_id: string | null;
  holdings: { symbol: string; shares: string | number; avg_cost: string | number }[];
}

// Postgres numerics arrive as strings over the wire; coercing at the boundary
// keeps every downstream calculation in plain numbers.
const num = (v: string | number): number => (typeof v === "number" ? v : Number(v));

function toInput(row: PortfolioRow): PortfolioInput {
  return {
    id: row.id,
    ownerType: row.owner_type,
    displayName: row.display_name,
    cash: num(row.cash),
    startingBalance: num(row.starting_balance),
    holdings: (row.holdings ?? []).map((h) => ({
      symbol: h.symbol,
      shares: num(h.shares),
      avgCost: num(h.avg_cost),
    })),
  };
}

const SELECT_PORTFOLIO =
  "id, owner_type, display_name, cash, starting_balance, profile_id, team_id, holdings(symbol, shares, avg_cost)";

export async function getActiveSeason() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("seasons")
    .select("id, name, slug, starting_balance, starts_at")
    .eq("is_active", true)
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Quotes for a set of symbols, deduplicated. */
export async function getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const unique = [...new Set(symbols.filter(Boolean))];
  if (unique.length === 0) return new Map();
  return marketData().getQuotes(unique);
}

/** The caller's portfolio in one specific competition — each competition is
 *  an independent portfolio, so this always needs to know which one. */
export async function getMyPortfolio(leagueId: string): Promise<ValuedPortfolio | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("portfolios")
    .select(SELECT_PORTFOLIO)
    .eq("profile_id", user.id)
    .eq("league_id", leagueId)
    .maybeSingle();
  if (!data) return null;

  const input = toInput(data as PortfolioRow);
  const quotes = await getQuotes(input.holdings.map((h) => h.symbol));
  return valuePortfolio(input, quotes);
}

/**
 * Every portfolio in a competition, valued and ranked.
 *
 * One quote fetch covers all competitors: with a couple of hundred players the
 * held symbols overlap heavily, so this is a handful of lookups rather than one
 * per player.
 */
export async function getLeaderboard(leagueId: string): Promise<LeaderboardRow[]> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("portfolios")
    .select(SELECT_PORTFOLIO)
    .eq("league_id", leagueId);

  if (!data?.length) return [];

  const rows = data as PortfolioRow[];
  const inputs = rows.map(toInput);
  const quotes = await getQuotes(inputs.flatMap((p) => p.holdings.map((h) => h.symbol)));
  const ranked = rankPortfolios(inputs.map((p) => valuePortfolio(p, quotes)));

  // team_id/team_name are not carried through ValuedPortfolio (it is shared
  // with CompetitorCard, where team is meaningless for the AI/Market
  // competitors) — captured separately here and merged back onto the ranked
  // rows instead.
  const teamIdByPortfolio = new Map<string, string | null>(rows.map((r) => [r.id, r.team_id]));
  const { data: teams } = await supabase.rpc("league_teams", { p_league_id: leagueId });
  const teamNameById = new Map<string, string>(
    ((teams ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  );

  return ranked.map((row) => {
    const teamId = teamIdByPortfolio.get(row.portfolioId) ?? null;
    return { ...row, teamId, teamName: teamId ? (teamNameById.get(teamId) ?? null) : null };
  });
}

/** Every team in a league, names only — anyone who can see the league can
 *  call this; it is deliberately RLS-free (see 0010_teams.sql), unlike a
 *  raw select against `teams` which only a team's own creator/members can
 *  read at all. */
export async function getLeagueTeams(leagueId: string): Promise<Team[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("league_teams", { p_league_id: leagueId });
  return (data ?? []) as Team[];
}

/** Teams the caller is entitled to see the passcode for — creator or
 *  member. The plain select IS the authorization here: RLS already
 *  restricts the rows returned to exactly that set. */
export async function getMyTeams(leagueId: string): Promise<MyTeam[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("teams")
    .select("id, name, code")
    .eq("league_id", leagueId);
  return (data ?? []) as MyTeam[];
}

export async function getPublicLeague() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("leagues")
    .select("id, name, code, season_id")
    .eq("is_public", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  return data;
}

/** The AI and Market (S&P 500) competitors in one competition, valued. The
 *  flagship has both; a "1v1 the AI" duel has only the AI; a plain
 *  user-created league has neither. */
export async function getSpecialCompetitors(leagueId: string): Promise<ValuedPortfolio[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("portfolios")
    .select(SELECT_PORTFOLIO)
    .eq("league_id", leagueId)
    .in("owner_type", ["ai", "benchmark"]);

  if (!data?.length) return [];

  const inputs = (data as PortfolioRow[]).map(toInput);
  const quotes = await getQuotes(inputs.flatMap((p) => p.holdings.map((h) => h.symbol)));

  // Fixed display order — AI, then Market — so the panel never reorders
  // itself between renders.
  const order = { ai: 0, benchmark: 1, human: 2, user: 3 } as const;
  return inputs
    .map((p) => valuePortfolio(p, quotes))
    .sort((a, b) => order[a.ownerType] - order[b.ownerType]);
}

export async function getRecentTrades(portfolioId: string, limit = 20): Promise<Trade[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("trades")
    .select("id, symbol, side, shares, price, amount, created_at")
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((t) => ({
    id: t.id as string,
    symbol: t.symbol as string,
    side: t.side as TradeSide,
    shares: num(t.shares as string | number),
    price: num(t.price as string | number),
    amount: num(t.amount as string | number),
    createdAt: t.created_at as string,
  }));
}

/**
 * Every competition the caller has a portfolio in, flagship first.
 *
 * "Flagship first" falls straight out of causality rather than needing its own
 * ordering flag: a user's flagship portfolio is always created at signup,
 * before they can create or join any other competition, so ordering by
 * portfolio `created_at` puts it first every time.
 */
export async function getMyCompetitions() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("portfolios")
    .select("created_at, leagues!inner(id, name, code, is_public)")
    .eq("profile_id", user.id)
    .eq("owner_type", "user")
    .order("created_at", { ascending: true });

  return (data ?? [])
    .map((r) => (r as unknown as { leagues: { id: string; name: string; code: string; is_public: boolean } }).leagues)
    .filter(Boolean);
}

/** A portfolio's still-open limit orders, oldest first. Filled and cancelled
 *  orders leave no row — see 0007_pending_orders.sql. */
export async function getPendingOrders(portfolioId: string): Promise<PendingOrder[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("pending_orders")
    .select("id, symbol, side, mode, quantity, target_price, created_at")
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: true });

  return (data ?? []).map((o) => ({
    id: o.id as string,
    symbol: o.symbol as string,
    side: o.side as "buy" | "sell",
    mode: o.mode as "shares" | "dollars",
    quantity: num(o.quantity as string | number),
    targetPrice: num(o.target_price as string | number),
    createdAt: o.created_at as string,
  }));
}

/** Latest messages in a league, oldest first — RLS already restricts this to
 *  confirmed members, so a non-member simply gets an empty array. Fetched
 *  newest-first with `limit` so the cap bounds the recent end of history,
 *  then reversed for display. */
export async function getLeagueMessages(
  leagueId: string,
  limit = 50,
  teamId: string | null = null,
): Promise<ChatMessage[]> {
  const supabase = await createClient();
  let query = supabase
    .from("league_messages")
    .select("id, sender_portfolio_id, body, created_at, portfolios(display_name, owner_type)")
    .eq("league_id", leagueId);
  query = teamId ? query.eq("team_id", teamId) : query.is("team_id", null);
  const { data } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  return (data ?? [])
    .map((m) => {
      const sender = m.portfolios as unknown as { display_name: string; owner_type: OwnerType };
      return {
        id: m.id as string,
        senderPortfolioId: m.sender_portfolio_id as string,
        displayName: sender.display_name,
        ownerType: sender.owner_type,
        body: m.body as string,
        createdAt: m.created_at as string,
      };
    })
    .reverse();
}

export async function getMyProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, username, is_admin")
    .eq("id", user.id)
    .maybeSingle();
  return data;
}
