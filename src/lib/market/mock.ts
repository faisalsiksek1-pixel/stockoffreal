import type { Quote } from "@/lib/types";
import { INSTRUMENTS, INSTRUMENT_BY_SYMBOL } from "./instruments";
import type { MarketDataProvider } from "./provider";

/**
 * Simulated prices, so the whole app works with no API key or network at all.
 *
 * Deterministic per symbol per day: every request within the same UTC day
 * returns the same price, and it changes overnight. That matters more than
 * realism — random prices on each request would make a portfolio's value jump
 * around between page loads and make P/L look broken.
 */

function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function dayIndex(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

/** Random walk seeded by symbol, replayed to `day` so history is consistent. */
function priceOn(symbol: string, base: number, vol: number, day: number): number {
  const daily = vol / Math.sqrt(252);
  let price = base;
  // 60 days of walk is enough to look alive without being slow.
  for (let d = day - 60; d <= day; d++) {
    const step = (hash(`${symbol}:${d}`) - 0.5) * 2 * daily;
    price *= 1 + step;
  }
  return Math.max(0.01, Math.round(price * 100) / 100);
}

export class MockProvider implements MarketDataProvider {
  readonly name = "mock";

  private quote(symbol: string): Quote | null {
    const inst = INSTRUMENT_BY_SYMBOL.get(symbol.toUpperCase());
    if (!inst) return null;
    const today = dayIndex(new Date());
    return {
      symbol: inst.symbol,
      name: inst.name,
      price: priceOn(inst.symbol, inst.base, inst.vol, today),
      prevClose: priceOn(inst.symbol, inst.base, inst.vol, today - 1),
    };
  }

  async getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    for (const s of symbols) {
      const q = this.quote(s);
      if (q) out.set(q.symbol, q);
    }
    return out;
  }

  async search(query: string): Promise<Quote[]> {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const matches = INSTRUMENTS.filter(
      (i) => i.symbol.includes(q) || i.name.toUpperCase().includes(q),
    )
      // Exact ticker match first, then ticker prefix, then name matches.
      .sort((a, b) => {
        const score = (i: typeof a) =>
          i.symbol === q ? 0 : i.symbol.startsWith(q) ? 1 : 2;
        return score(a) - score(b) || a.symbol.localeCompare(b.symbol);
      })
      .slice(0, 12);
    return matches.map((i) => this.quote(i.symbol)!).filter(Boolean);
  }

  /** Daily closes for a sparkline. Same walk, so the chart matches the quote. */
  history(symbol: string, days = 30): { t: number; price: number }[] {
    const inst = INSTRUMENT_BY_SYMBOL.get(symbol.toUpperCase());
    if (!inst) return [];
    const today = dayIndex(new Date());
    return Array.from({ length: days }, (_, i) => {
      const day = today - (days - 1 - i);
      return { t: day, price: priceOn(inst.symbol, inst.base, inst.vol, day) };
    });
  }
}
