import type { Quote } from "@/lib/types";

/**
 * The only surface the rest of the app knows about. Swapping data vendors means
 * writing one new implementation of this and changing one env var — no callers
 * change.
 */
export interface MarketDataProvider {
  readonly name: string;
  getQuotes(symbols: string[]): Promise<Map<string, Quote>>;
  search(query: string): Promise<Quote[]>;
}
