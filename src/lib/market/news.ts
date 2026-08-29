export interface NewsItem {
  id: string;
  headline: string;
  /** Omitted when Finnhub's summary is just the headline repeated — common
   *  for wire-service stories (Reuters) where the licensed text is only the
   *  headline itself, unlike original CNBC pieces which get a real excerpt. */
  summary?: string;
  source: string;
  url: string;
  publishedAt: string; // ISO
  /** Article thumbnail — Finnhub omits this for some stories, hence optional. */
  image?: string;
  category?: string;
}

/** True when `summary` adds nothing over `headline` — e.g. the same text
 *  with the " - Source" suffix dropped or reworded, which Finnhub does for
 *  syndicated wire content it isn't licensed to excerpt. */
function isRedundantSummary(headline: string, summary: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const h = normalize(headline);
  const s = normalize(summary);
  return s.length === 0 || s === h || h.startsWith(s) || s.startsWith(h);
}

/**
 * General market news, reusing the same MARKET_DATA_PROVIDER/FINNHUB_API_KEY
 * config as quotes — a capability not every vendor has, so (like
 * priceHistory in lib/market/index.ts) it lives outside MarketDataProvider
 * rather than being forced onto every implementation.
 *
 * Returns [] when no real provider is configured, or a Finnhub-specific
 * error occurs — never fabricated headlines. Financial news is exactly the
 * wrong place to show something that looks real but isn't, even in a
 * clearly-labelled simulation game.
 */
export async function marketNews(limit = 8): Promise<NewsItem[]> {
  const choice = (process.env.MARKET_DATA_PROVIDER ?? "mock").toLowerCase();
  const key = process.env.FINNHUB_API_KEY;
  if (choice !== "finnhub" || !key) return [];

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/news?category=general&token=${key}`,
      { next: { revalidate: 300 } }, // news moves slower than quotes; 60s there, 5min here
    );
    if (!res.ok) return [];

    const raw = (await res.json()) as {
      id: number;
      headline: string;
      summary: string;
      source: string;
      url: string;
      datetime: number;
      image?: string;
      category?: string;
    }[];

    // Some Finnhub stories carry an empty headline/url — not worth showing.
    return raw
      .filter((n) => n.headline && n.url)
      .slice(0, limit)
      .map((n) => ({
        id: String(n.id),
        headline: n.headline,
        summary: isRedundantSummary(n.headline, n.summary ?? "") ? undefined : n.summary,
        source: n.source,
        url: n.url,
        publishedAt: new Date(n.datetime * 1000).toISOString(),
        image: n.image || undefined,
        category: n.category || undefined,
      }));
  } catch {
    return [];
  }
}
