import type { Holding, TradeSide } from "./types";

/**
 * Trade rules, expressed once as pure functions.
 *
 * These mirror the checks inside the execute_trade SQL function. The database is
 * the authority — it holds the row lock and is the only thing that can safely
 * reject a race — but having the same rules here lets the UI explain a problem
 * before a round trip, and lets the rules be unit-tested.
 *
 * Version 2 adds short selling: `holding.shares` is a signed net position
 * (positive long, negative short), and a symbol must be closed out in one
 * direction before opening the other — buy/sell only ever act on a
 * long-or-flat position, short/cover only ever act on a short-or-flat one.
 *
 * Shorting requires 1:1 cash collateral. `buy` is checked against
 * `availableCash` (cash net of every open short's liability, from
 * `src/lib/portfolio.ts`'s `shortLiability`) rather than raw `cash`, so a
 * short's proceeds cannot be double-spent on an unrelated long.
 *
 * `short` needs an extra subtraction that is easy to miss: opening a short
 * credits cash by the trade amount *and* raises liability by the same
 * amount, so `availableCash` (cash minus liability) is mathematically
 * invariant under shorting — checking a new short against it would only ever
 * bound a single trade's size, never the running total, letting unlimited
 * small shorts through. Subtracting liability a second time
 * (`availableCash - shortLiability`, equivalent to `cash - 2*liability`)
 * gives a figure that shrinks by exactly the trade amount on every short, so
 * total short liability actually caps out at half of cash — i.e. at the
 * cash the account had before any of it was shorted.
 *
 * `leverage` scales buying power only — it multiplies the ceiling that `buy`
 * and `short` are checked against, nothing else. There is no interest and no
 * margin call: a leveraged buy or short simply spends real cash it does not
 * have, same as `execute_trade` always has, so cash can go negative
 * (margin debt) and `totalValue` (cash + holdings) correctly reflects it as
 * a drag on the account. `sell` and `cover` are untouched — closing a
 * position never needs extra buying power, so they ignore `leverage`
 * entirely.
 *
 * `leverage` is chosen per order, not per portfolio: the trader picks a
 * multiplier from `LEVERAGE_OPTIONS` each time they place a `buy` or
 * `short`, same as choosing dollars vs. shares. Mirrors `execute_trade` in
 * the database, which takes the same `p_leverage` argument and is the real
 * authority — this is only ever a pre-check.
 */

export const MIN_ORDER_VALUE = 1;

/** Buying-power multipliers a trader may choose for a `buy` or `short`
 *  order. Mirrors the `v_leverage` check in `execute_trade` — change both
 *  together. */
export const LEVERAGE_OPTIONS = [1, 2, 5, 10, 20] as const;

export type Leverage = (typeof LEVERAGE_OPTIONS)[number];

/** What a fresh order form starts on. Matches the multiplier this app used
 *  before leverage became selectable. */
export const DEFAULT_LEVERAGE: Leverage = 2;

export function isLeverageOption(value: number): value is Leverage {
  return (LEVERAGE_OPTIONS as readonly number[]).includes(value);
}

export interface OrderRequest {
  symbol: string;
  side: TradeSide;
  /** Exactly one of these is supplied; the other is derived from the price. */
  shares?: number;
  dollars?: number;
}

export type OrderCheck =
  | { ok: true; shares: number; amount: number }
  | { ok: false; error: string };

/** Convert a dollar amount or share count into a validated share quantity. */
export function resolveOrder(
  req: OrderRequest,
  price: number,
  cash: number,
  availableCash: number,
  shortLiability: number,
  holding: Holding | undefined,
  leverage: number = DEFAULT_LEVERAGE,
): OrderCheck {
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: "No usable price for this symbol right now." };
  }

  if (!isLeverageOption(leverage)) {
    return { ok: false, error: "Choose a valid leverage." };
  }

  let shares: number;
  if (req.shares !== undefined) {
    if (!Number.isFinite(req.shares) || req.shares <= 0) {
      return { ok: false, error: "Enter a quantity greater than zero." };
    }
    shares = req.shares;
  } else if (req.dollars !== undefined) {
    if (!Number.isFinite(req.dollars) || req.dollars <= 0) {
      return { ok: false, error: "Enter an amount greater than zero." };
    }
    // Fractional shares, rounded down so a dollar order never exceeds its
    // requested amount.
    shares = Math.floor((req.dollars / price) * 1e6) / 1e6;
    if (shares <= 0) {
      return { ok: false, error: `That is less than one share of this stock.` };
    }
  } else {
    return { ok: false, error: "Enter either a dollar amount or a share count." };
  }

  const amount = Math.round(shares * price * 100) / 100;
  if (amount < MIN_ORDER_VALUE) {
    return { ok: false, error: `Minimum order is $${MIN_ORDER_VALUE}.` };
  }

  const held = holding?.shares ?? 0;

  if (req.side === "buy") {
    if (held < 0) {
      return {
        ok: false,
        error: `You are short ${req.symbol}. Cover it before buying it long.`,
      };
    }
    // Compared at cent precision so a $100,000.00 order against exactly
    // $100,000.00 of available cash is allowed rather than failing on float dust.
    const buyingPower = availableCash * leverage;
    if (amount > Math.round(buyingPower * 100) / 100) {
      return {
        ok: false,
        error: `Not enough buying power. That order costs $${amount.toFixed(2)} and you have $${buyingPower.toFixed(2)} available at ${leverage}x leverage.`,
      };
    }
  } else if (req.side === "sell") {
    if (held < 0) {
      return {
        ok: false,
        error: `You are short ${req.symbol}. Use cover to close it, not sell.`,
      };
    }
    if (held <= 0) {
      return { ok: false, error: `You do not own any ${req.symbol}.` };
    }
    if (shares > held + 1e-9) {
      return { ok: false, error: `You only own ${held} share(s) of ${req.symbol}.` };
    }
  } else if (req.side === "short") {
    if (held > 0) {
      return {
        ok: false,
        error: `You are long ${req.symbol}. Sell it before shorting it.`,
      };
    }
    // See the file header: this is deliberately availableCash minus
    // liability again, not availableCash alone.
    const shortCapacity = (availableCash - shortLiability) * leverage;
    if (amount > Math.round(shortCapacity * 100) / 100) {
      return {
        ok: false,
        error: `Not enough buying power to short. That needs $${amount.toFixed(2)} and you have $${shortCapacity.toFixed(2)} available at ${leverage}x leverage.`,
      };
    }
  } else {
    // cover
    if (held > 0) {
      return {
        ok: false,
        error: `You are long ${req.symbol}. Use sell to close it, not cover.`,
      };
    }
    if (held >= 0) {
      return { ok: false, error: `You are not short ${req.symbol}.` };
    }
    if (shares > -held + 1e-9) {
      return {
        ok: false,
        error: `You are only short ${-held} share(s) of ${req.symbol}.`,
      };
    }
    if (amount > Math.round(cash * 100) / 100) {
      return {
        ok: false,
        error: `Not enough cash to cover. That costs $${amount.toFixed(2)} and you have $${cash.toFixed(2)}.`,
      };
    }
  }

  return { ok: true, shares, amount };
}

/** Weighted average cost after adding to a position. Mirrors the SQL. */
export function newAverageCost(
  existing: Holding | undefined,
  shares: number,
  price: number,
): number {
  if (!existing) return Math.round(price * 10000) / 10000;
  const total = existing.shares + shares;
  const cost = existing.shares * existing.avgCost + shares * price;
  return Math.round((cost / total) * 10000) / 10000;
}
