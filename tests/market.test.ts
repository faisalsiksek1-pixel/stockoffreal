import { describe, expect, it } from "vitest";

import { INSTRUMENTS, BENCHMARK_SYMBOL } from "@/lib/market/instruments";
import { MockProvider } from "@/lib/market/mock";

/**
 * The mock provider is what makes the app usable with no API key, so its two
 * important properties are worth pinning down: it covers the whole universe, and
 * it is stable within a day. Prices that changed on every request would make
 * portfolio values jump between page loads.
 */
describe("mock market data", () => {
  const market = new MockProvider();

  it("quotes every instrument in the universe", async () => {
    const quotes = await market.getQuotes(INSTRUMENTS.map((i) => i.symbol));
    expect(quotes.size).toBe(INSTRUMENTS.length);
    for (const q of quotes.values()) {
      expect(q.price).toBeGreaterThan(0);
      expect(q.prevClose).toBeGreaterThan(0);
      expect(q.name.length).toBeGreaterThan(0);
    }
  });

  it("returns the same price for repeated requests", async () => {
    const a = await market.getQuotes(["AAPL"]);
    const b = await market.getQuotes(["AAPL"]);
    expect(a.get("AAPL")!.price).toBe(b.get("AAPL")!.price);
  });

  it("ignores unknown symbols instead of inventing a price", async () => {
    const quotes = await market.getQuotes(["NOTAREALTICKER"]);
    expect(quotes.size).toBe(0);
  });

  it("includes the benchmark instrument", () => {
    expect(INSTRUMENTS.some((i) => i.symbol === BENCHMARK_SYMBOL)).toBe(true);
  });

  it("ships at least 15 tradeable instruments", () => {
    expect(INSTRUMENTS.length).toBeGreaterThanOrEqual(15);
  });

  it("searches by ticker and by company name", async () => {
    const byTicker = await market.search("NVDA");
    expect(byTicker[0]!.symbol).toBe("NVDA");

    const byName = await market.search("apple");
    expect(byName.some((q) => q.symbol === "AAPL")).toBe(true);
  });

  it("ranks an exact ticker match first", async () => {
    const results = await market.search("V");
    expect(results[0]!.symbol).toBe("V");
  });

  it("returns nothing for an empty query", async () => {
    expect(await market.search("   ")).toEqual([]);
  });

  it("produces history matching the current quote", async () => {
    const history = market.history("AAPL", 30);
    const quotes = await market.getQuotes(["AAPL"]);
    expect(history).toHaveLength(30);
    // The final history point is today, so it must equal today's quote.
    expect(history.at(-1)!.price).toBe(quotes.get("AAPL")!.price);
  });
});
