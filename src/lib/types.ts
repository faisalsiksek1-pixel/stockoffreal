export type OwnerType = "user" | "ai" | "human" | "benchmark";
export type TradeSide = "buy" | "sell" | "short" | "cover";

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
}

export interface Holding {
  symbol: string;
  shares: number;
  avgCost: number;
}

export interface Trade {
  id: string;
  symbol: string;
  side: TradeSide;
  shares: number;
  price: number;
  amount: number;
  createdAt: string;
}

/** A limit order waiting for its price target to be crossed. Buy/sell only —
 *  see supabase/migrations/0007_pending_orders.sql. */
export interface PendingOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  mode: "shares" | "dollars";
  quantity: number;
  targetPrice: number;
  createdAt: string;
}

/** A holding joined with its live quote — everything the UI needs per row. */
export interface ValuedHolding extends Holding {
  name: string;
  price: number;
  marketValue: number;
  costBasis: number;
  pnl: number;
  pnlPct: number;
  weight: number;
  dayChangePct: number;
  /** Negative shares — a short position rather than a long one. */
  isShort: boolean;
}

export interface ValuedPortfolio {
  id: string;
  ownerType: OwnerType;
  displayName: string;
  cash: number;
  /** Cash minus the live liability of every open short. What buy/short may spend. */
  availableCash: number;
  startingBalance: number;
  holdingsValue: number;
  totalValue: number;
  totalReturn: number;
  totalReturnPct: number;
  dayChangePct: number;
  holdings: ValuedHolding[];
}

/** Shared between the server-side resolver (`lib/competition.ts`) and the
 *  client-side switcher component — kept here, not in `lib/competition.ts`,
 *  because that module imports `next/headers` and cannot be pulled into a
 *  client bundle. */
export const COMPETITION_COOKIE = "stockoff-competition";

/** A competition (internally still a `leagues` row) the caller has a
 *  portfolio in. Raw shape from Supabase, matching how it has always been
 *  returned here — never normalized to camelCase. */
export interface Competition {
  id: string;
  name: string;
  code: string;
  is_public: boolean;
}

/** A league chat message, sender identity resolved through its portfolio —
 *  see supabase/migrations/0009_league_chat.sql. */
export interface ChatMessage {
  id: string;
  senderPortfolioId: string;
  displayName: string;
  ownerType: OwnerType;
  body: string;
  createdAt: string;
}

export interface LeaderboardRow {
  rank: number;
  portfolioId: string;
  ownerType: OwnerType;
  displayName: string;
  totalValue: number;
  totalReturnPct: number;
  dayChangePct: number;
  teamId?: string | null;
  teamName?: string | null;
}

/** A team within a league — see supabase/migrations/0010_teams.sql. Names
 *  are visible to anyone who can see the league; `code` is visible only to
 *  the team's own creator or members, which is why it is a separate,
 *  narrower type rather than always present on `Team`. */
export interface Team {
  id: string;
  name: string;
}
export interface MyTeam extends Team {
  code: string;
}

export interface TeamStanding {
  rank: number;
  teamId: string;
  teamName: string;
  memberCount: number;
  avgReturnPct: number;
}
