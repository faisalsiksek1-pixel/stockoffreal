import Link from "next/link";
import { redirect } from "next/navigation";

import { signOut } from "@/actions/auth";
import { Disclaimer } from "@/components/Disclaimer";
import { Button } from "@/components/ui/Button";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeading } from "@/components/ui/PageHeading";
import { Stat } from "@/components/ui/Stat";
import { resolveCompetition } from "@/lib/competition";
import { money, percent } from "@/lib/format";
import { getMyPortfolio, getMyProfile } from "@/lib/queries";

export const metadata = { title: "Profile - StockOff" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const resolved = await resolveCompetition();
  if (!resolved) redirect("/welcome");

  const [profile, portfolio] = await Promise.all([
    getMyProfile(),
    getMyPortfolio(resolved.leagueId),
  ]);
  if (!profile || !portfolio) redirect("/welcome");

  return (
    <div className="space-y-6">
      <div>
        <PageHeading>@{profile.username}</PageHeading>
        <p className="mt-1 text-sm text-muted">
          {resolved.competitions.find((c) => c.id === resolved.leagueId)?.name ?? "StockOff League"} player
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Portfolio" value={money(portfolio.totalValue)} />
          <Stat
            label="Total return"
            value={percent(portfolio.totalReturnPct)}
            tone={portfolio.totalReturnPct}
          />
          <Stat label="Cash" value={money(portfolio.cash)} />
          <Stat label="Positions" value={String(portfolio.holdings.length)} />
        </div>
      </Card>

      <Card>
        <CardTitle>Quick links</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/share"
            className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold hover:border-muted"
          >
            Share result
          </Link>
          <Link
            href="/leagues"
            className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold hover:border-muted"
          >
            Leagues
          </Link>
          {profile.is_admin ? (
            <Link
              href="/admin"
              className="rounded-xl border border-ai px-4 py-2.5 text-sm font-semibold text-ai"
            >
              Admin
            </Link>
          ) : null}
        </div>
      </Card>

      <form action={signOut}>
        <Button type="submit" variant="secondary">
          Sign out
        </Button>
      </form>

      <Disclaimer />
    </div>
  );
}
