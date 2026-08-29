import Link from "next/link";

import { LeaderboardTable } from "@/components/LeaderboardTable";
import { Disclaimer } from "@/components/Disclaimer";
import { Wordmark } from "@/components/Wordmark";
import { Empty } from "@/components/ui/Empty";
import { PageHeading } from "@/components/ui/PageHeading";
import { getLeaderboard, getMyPortfolio, getPublicLeague } from "@/lib/queries";

export const metadata = { title: "Leaderboard - StockOff" };
export const dynamic = "force-dynamic";

/**
 * Public leaderboard — readable without an account, so it can be linked from
 * anywhere and works as the top of the funnel.
 */
export default async function LeaderboardPage() {
  const league = await getPublicLeague();
  const rows = league ? await getLeaderboard(league.id) : [];
  const mine = league ? await getMyPortfolio(league.id) : null;

  return (
    <div className="mx-auto max-w-3xl px-5 pb-16 pt-8">
      <header className="mb-8 flex items-center justify-between">
        <Link href={mine ? "/dashboard" : "/"}>
          <Wordmark className="text-lg" />
        </Link>
        {mine ? (
          <Link href="/dashboard" className="text-sm font-medium text-muted hover:text-fg">
            Dashboard
          </Link>
        ) : (
          <Link
            href="/signup"
            className="rounded-xl bg-ai px-4 py-2 text-sm font-semibold text-on-accent"
          >
            Start with $100K
          </Link>
        )}
      </header>

      <PageHeading>{league?.name ?? "StockOff League"}</PageHeading>
      <p className="mt-2 text-sm text-muted">
        Ranked by percentage return. Everyone starts at $100,000.
      </p>

      <div className="mt-6">
        {rows.length ? (
          <LeaderboardTable rows={rows} highlightId={mine?.id} />
        ) : (
          <Empty title="The board is empty">
            StockOff League has no players yet. Run the seed script, or{" "}
            <Link href="/signup" className="font-medium text-ai hover:underline">
              claim the first spot
            </Link>
            .
          </Empty>
        )}
      </div>

      <p className="mt-4 text-xs text-muted">
        Rankings show top-performing players for this season. They are not a
        judgement of investing skill.
      </p>

      <footer className="mt-12 border-t border-line pt-6">
        <Disclaimer />
      </footer>
    </div>
  );
}
