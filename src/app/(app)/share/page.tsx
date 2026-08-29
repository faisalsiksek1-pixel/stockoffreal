import { redirect } from "next/navigation";

import { CopyButton } from "@/components/CopyButton";
import { PageHeading } from "@/components/ui/PageHeading";
import { resolveCompetition } from "@/lib/competition";
import { money, percent } from "@/lib/format";
import { findRank } from "@/lib/portfolio";
import { getLeaderboard, getMyPortfolio, getMyProfile } from "@/lib/queries";

export const metadata = { title: "Share your result - StockOff" };
export const dynamic = "force-dynamic";

/**
 * Shareable result card.
 *
 * Rendered as real DOM rather than a generated image: it is screenshot-friendly
 * on a phone, which is how these actually get shared, and it needs no image
 * pipeline for v1.
 */
export default async function SharePage() {
  const resolved = await resolveCompetition();
  if (!resolved) redirect("/welcome");

  const [portfolio, profile] = await Promise.all([
    getMyPortfolio(resolved.leagueId),
    getMyProfile(),
  ]);
  if (!portfolio || !profile) redirect("/welcome");

  const rows = await getLeaderboard(resolved.leagueId);
  const rank = findRank(rows, portfolio.id);
  const shareUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const positive = portfolio.totalReturnPct >= 0;

  return (
    <div className="space-y-5">
      <PageHeading>Share your result</PageHeading>

      <div className="overflow-hidden rounded-2xl border border-line bg-gradient-to-b from-surface-2 to-surface p-6 sm:p-8">
        <div className="flex items-center justify-between">
          <span className="text-sm font-extrabold tracking-tight">
            Stock<span className="text-ai">Off</span>
          </span>
          <span className="text-2xs font-semibold uppercase tracking-widest text-muted">
            {resolved.competitions.find((c) => c.id === resolved.leagueId)?.name ?? "StockOff League"}
          </span>
        </div>

        <div className="mt-7">
          <div className="text-sm text-muted">@{profile.username}</div>
          <div
            className={`tnum mt-1 text-5xl font-extrabold tracking-tight sm:text-6xl ${
              positive ? "text-up" : "text-down"
            }`}
          >
            {percent(portfolio.totalReturnPct)}
          </div>
          <div className="tnum mt-1 text-lg text-muted">
            {money(portfolio.totalValue)}
          </div>
        </div>

        <div className="mt-7 flex items-end justify-between gap-4">
          <div>
            <div className="text-2xs font-semibold uppercase tracking-widest text-muted">
              League rank
            </div>
            <div className="tnum text-2xl font-semibold">
              {rank ? `#${rank}` : "-"}
              {rows.length ? (
                <span className="text-sm font-normal text-muted"> of {rows.length}</span>
              ) : null}
            </div>
          </div>
          <p className="max-w-[10rem] text-right text-sm font-semibold leading-snug">
            Can you beat me on StockOff?
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <CopyButton value={shareUrl || "StockOff"} label="Copy share link" />
        <CopyButton
          value={`I'm ${percent(portfolio.totalReturnPct)} on StockOff${rank ? `, rank #${rank}` : ""}. Can you beat me? ${shareUrl}`}
          label="Copy text"
        />
      </div>

      <p className="text-xs text-muted">
        Screenshot the card to share it. Simulated results only.
      </p>
    </div>
  );
}
