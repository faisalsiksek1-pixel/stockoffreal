import Link from "next/link";

import { CreateLeagueForm, JoinLeagueForm, JoinTeamForm, StartAiDuelButton } from "@/components/LeagueForms";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeading } from "@/components/ui/PageHeading";
import { getUnreadChatCounts } from "@/lib/notifications";
import { getMyCompetitions } from "@/lib/queries";

export const metadata = { title: "Leagues - StockOff" };
export const dynamic = "force-dynamic";

export default async function LeaguesPage() {
  const competitions = await getMyCompetitions();
  const unread = await getUnreadChatCounts(competitions.map((c) => c.id));

  return (
    <div className="space-y-6">
      <div>
        <PageHeading>Leagues</PageHeading>
        <p className="mt-1 text-sm text-muted">
          Everyone starts in StockOff League. Each one you join or create gives
          you a fresh, independent portfolio.
        </p>
      </div>

      <section>
        <CardTitle>Your competitions</CardTitle>
        <ul className="space-y-2">
          {competitions.map((l) => (
            <li key={l.id}>
              <Link
                href={l.is_public ? "/leaderboard" : `/leagues/${l.code}`}
                className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4 transition hover:border-muted"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{l.name}</span>
                    {unread.get(l.id) ? <Badge tone="ai">{unread.get(l.id)} new</Badge> : null}
                  </div>
                  <div className="text-xs text-muted">
                    {l.is_public ? "Public season" : `Code ${l.code}`}
                  </div>
                </div>
                <span className="text-sm text-muted">View</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>1v1 the AI</CardTitle>
          <p className="mb-3 text-sm text-muted">
            Just you and a fresh $100,000 AI portfolio, starting even.
          </p>
          <StartAiDuelButton />
        </Card>
        <Card>
          <CardTitle>Start a private league</CardTitle>
          <CreateLeagueForm />
        </Card>
        <Card>
          <CardTitle>Join with a code</CardTitle>
          <JoinLeagueForm />
        </Card>
        <Card>
          <CardTitle>Join a team</CardTitle>
          <p className="mb-3 text-sm text-muted">
            Have a team code instead? It joins you to the league and that team in one step.
          </p>
          <JoinTeamForm />
        </Card>
      </div>
    </div>
  );
}
