import type { Quote } from "@/lib/types";
import { INSTRUMENT_BY_SYMBOL } from "./instruments";
import type { MarketDataProvider } from "./provider";

/**
 * Finnhub — free tier gives delayed US quotes. Chosen because it needs no
 * paid plan to be useful; any vendor implementing MarketDataProvider works.
 *
 * Quotes are fetched one symbol per call (the free tier has no batch endpoint),
 * so callers should pass the symbols they actually need. A failed symbol is
 * skipped rather than failing the whole request: one bad ticker must not blank
 * out a user's entire portfolio.
 */
export class FinnhubProvider implements MarketDataProvider {
  readonly name = "finnhub";

  constructor(private readonly apiKey: string) {}

  private async fetchOne(symbol: string): Promise<Quote | null> {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${this.apiKey}`,
        { next: { revalidate: 60 } },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { c?: number; pc?: number };
      if (!data.c || data.c <= 0) return null;
      return {
        symbol: symbol.toUpperCase(),
        name: INSTRUMENT_BY_SYMBOL.get(symbol.toUpperCase())?.name ?? symbol,
        price: data.c,
        prevClose: data.pc && data.pc > 0 ? data.pc : data.c,
      };
    } catch {
      return null;
    }
  }

  async getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
    const results = await Promise.all(symbols.map((s) => this.fetchOne(s)));
    const out = new Map<string, Quote>();
    for (const q of results) if (q) out.set(q.symbol, q);
    return out;
  }

  /** Search stays local: the universe is curated, so no API call is needed. */
  async search(query: string): Promise<Quote[]> {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const symbols = [...INSTRUMENT_BY_SYMBOL.values()]
      .filter((i) => i.symbol.includes(q) || i.name.toUpperCase().includes(q))
      .slice(0, 12)
      .map((i) => i.symbol);
    const quotes = await this.getQuotes(symbols);
    return symbols.map((s) => quotes.get(s)).filter((q): q is Quote => Boolean(q));
  }
}
