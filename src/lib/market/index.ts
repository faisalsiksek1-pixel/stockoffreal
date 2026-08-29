import { FinnhubProvider } from "./finnhub";
import { MockProvider } from "./mock";
import type { MarketDataProvider } from "./provider";

export type { MarketDataProvider } from "./provider";
export { BENCHMARK_SYMBOL, INSTRUMENTS } from "./instruments";
export { MockProvider } from "./mock";
export { marketNews, type NewsItem } from "./news";

let cached: MarketDataProvider | null = null;

/**
 * Resolve the configured provider. Falls back to mock whenever a real provider
 * is asked for but not usable, so a missing key degrades to a working app rather
 * than a broken one.
 */
export function marketData(): MarketDataProvider {
  if (cached) return cached;

  const choice = (process.env.MARKET_DATA_PROVIDER ?? "mock").toLowerCase();
  const key = process.env.FINNHUB_API_KEY;

  if (choice === "finnhub") {
    if (key) {
      cached = new FinnhubProvider(key);
      return cached;
    }
    console.warn("[market] MARKET_DATA_PROVIDER=finnhub but FINNHUB_API_KEY is unset — using mock prices.");
  }

  cached = new MockProvider();
  return cached;
}

/** Sparklines come from the mock walk regardless of provider: the free tiers of
 *  most vendors do not include candles, and a chart is nice-to-have. */
export function priceHistory(symbol: string, days = 30) {
  return new MockProvider().history(symbol, days);
}
