/**
 * Real daily price history, used only for the trade-page chart — the quote
 * itself still comes from whichever MarketDataProvider is configured (see
 * index.ts). Twelve Data's free tier includes daily time_series for US
 * equities (unlike Finnhub's, which gates candles behind a paid plan), so
 * this is a second, independent provider rather than a MarketDataProvider
 * implementation.
 *
 * Cached for a day via Next's fetch cache: one real request per symbol per
 * day covers every visitor, well inside the free tier's 800/day limit.
 */
export async function fetchDailyHistory(
  symbol: string,
  days: number,
  apiKey: string,
): Promise<{ t: number; price: number }[] | null> {
  try {
    const res = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${days}&apikey=${apiKey}`,
      { next: { revalidate: 86_400 } },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      status?: string;
      values?: { datetime: string; close: string }[];
    };
    if (data.status !== "ok" || !data.values?.length) return null;

    return data.values
      .map((v) => ({
        t: Math.floor(new Date(v.datetime).getTime() / 86_400_000),
        price: Number(v.close),
      }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.price) && p.price > 0)
      .sort((a, b) => a.t - b.t);
  } catch {
    return null;
  }
}
