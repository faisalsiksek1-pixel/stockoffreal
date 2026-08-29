import { Badge } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Empty";
import { PageHeading } from "@/components/ui/PageHeading";
import { marketNews } from "@/lib/market";
import type { NewsItem } from "@/lib/market";

export const metadata = { title: "News - StockOff" };
export const dynamic = "force-dynamic";

function newsDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The lead story: bigger image, bigger headline, the summary Finnhub already
 *  gives us — plain text everywhere else in this app never had a reason to
 *  render an image or a pull-quote, but a news feed with neither just reads
 *  as a bare link list. */
function FeaturedStory({ item }: { item: NewsItem }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block overflow-hidden rounded-2xl border border-line bg-surface transition hover:border-muted"
    >
      {item.image ? (
        // Third-party article images come from arbitrary, unpredictable
        // hosts — a plain <img>, not next/image, which would need every
        // publisher's domain allowlisted up front.
        <img src={item.image} alt="" className="aspect-[2/1] w-full object-cover sm:aspect-[3/1]" />
      ) : null}
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {item.category ? <Badge tone="neutral">{item.category}</Badge> : null}
          <span>{item.source}</span>
          <span aria-hidden>·</span>
          <span>{newsDate(item.publishedAt)}</span>
        </div>
        <div className="mt-2 text-lg font-semibold leading-snug sm:text-xl">{item.headline}</div>
        {item.summary ? (
          <p className="mt-1.5 line-clamp-2 text-sm text-muted">{item.summary}</p>
        ) : null}
      </div>
    </a>
  );
}

function StoryRow({ item }: { item: NewsItem }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex gap-3 px-4 py-3 transition hover:bg-surface-2"
    >
      {item.image ? (
        <img src={item.image} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="h-16 w-16 shrink-0 rounded-lg bg-surface-2" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-semibold leading-snug">{item.headline}</div>
        {item.summary ? <p className="mt-0.5 line-clamp-1 text-sm text-muted">{item.summary}</p> : null}
        <div className="mt-1 text-xs text-muted">
          {item.source} · {newsDate(item.publishedAt)}
        </div>
      </div>
    </a>
  );
}

export default async function NewsPage() {
  const news = await marketNews(20);
  const [featured, ...rest] = news;

  return (
    <div className="space-y-5">
      <PageHeading>News</PageHeading>

      {!featured ? (
        <Empty title="No live news configured">
          Set MARKET_DATA_PROVIDER=finnhub and FINNHUB_API_KEY to show real market news here.
        </Empty>
      ) : (
        <>
          <FeaturedStory item={featured} />

          {rest.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {rest.map((item) => (
                <li key={item.id}>
                  <StoryRow item={item} />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
