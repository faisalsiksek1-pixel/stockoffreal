import Link from "next/link";
import { notFound } from "next/navigation";

import { CopyButton } from "@/components/CopyButton";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { LeagueChat } from "@/components/LeagueChat";
import { AcceptInviteButton, AddTeamForm } from "@/components/LeagueForms";
import { TeamStandings } from "@/components/TeamStandings";
import { Badge } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Empty";
import { PageHeading } from "@/components/ui/PageHeading";
import { markChatRead } from "@/lib/notifications";
import { rankTeams } from "@/lib/portfolio";
import {
  getLeaderboard,
  getLeagueMessages,
  getLeagueTeams,
  getMyPortfolio,
  getMyProfile,
  getMyTeams,
} from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import type { ChatMessage } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LeaguePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const supabase = await createClient();

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, code, is_public, created_by")
    .ilike("code", code)
    .maybeSingle();

  // A private league is only readable by its members, so arriving on an invite
  // link returns nothing the first time. Fall back to the preview function and
  // offer to join, rather than showing a 404 for a link that is perfectly valid.
  if (!league) {
    const { data } = await supabase
      .rpc("league_preview", { p_code: code })
      .maybeSingle();

    const found = data as { id: string; name: string; member_count: number } | null;
    if (!found) notFound();

    return (
      <div className="space-y-5">
        <div>
          <Link href="/leagues" className="text-sm text-muted hover:text-fg">
            ← Leagues
          </Link>
          <PageHeading className="mt-2">{found.name}</PageHeading>
          <p className="mt-1 text-sm text-muted">
            You have been invited to this league.{" "}
            {found.member_count === 1 ? "1 player" : `${found.member_count} players`} so
            far.
          </p>
        </div>
        <AcceptInviteButton code={code} />
        <p className="text-xs text-muted">
          Joining gives you a fresh $100,000 portfolio just for this competition,
          independent of any others you&rsquo;re in.
        </p>
      </div>
    );
  }

  const [rows, mine, teams] = await Promise.all([
    getLeaderboard(league.id),
    getMyPortfolio(league.id),
    getLeagueTeams(league.id),
  ]);

  const [messages, profile, myTeams] = mine
    ? await Promise.all([
        getLeagueMessages(league.id),
        getMyProfile(),
        getMyTeams(league.id),
        // Loading this page IS "you saw the chat" — same side-effect-of-the-
        // page-load idiom fillDueOrders uses for limit orders. Only for
        // confirmed members; a non-member has nothing to mark read anyway.
        markChatRead(league.id),
      ])
    : [[] as ChatMessage[], null, []];

  const teamStandings = rankTeams(rows.filter((r) => r.ownerType === "user"));
  const isCreator = mine !== null && profile?.id === league.created_by;

  const myRow = rows.find((r) => r.portfolioId === mine?.id);
  const myTeam = myRow?.teamId && myRow?.teamName ? { id: myRow.teamId, name: myRow.teamName } : null;

  // Built from the env var so the copied link is correct in local dev and on
  // Vercel without a code change.
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  const inviteLink = `${base}/leagues/${league.code}`;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/leagues" className="text-sm text-muted hover:text-fg">
          ← Leagues
        </Link>
        <PageHeading className="mt-2">{league.name}</PageHeading>
        <p className="mt-1 text-sm text-muted">
          Invite code{" "}
          <span className="font-mono font-semibold tracking-widest text-fg">
            {league.code}
          </span>
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <CopyButton value={league.code} label="Copy code" />
        <CopyButton value={inviteLink} label="Copy invite link" />
      </div>

      {myTeams.length > 0 ? (
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">
            Your teams
          </h2>
          <div className="space-y-2">
            {myTeams.map((team) => (
              <div
                key={team.id}
                className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-3"
              >
                <span className="font-semibold">{team.name}</span>
                <CopyButton value={team.code} label="Copy team code" />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {teams.length > 0 ? (
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">
            Teams in this league
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {teams.map((team) => (
              <Badge key={team.id} tone="neutral">
                {team.name}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {isCreator ? (
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">
            Add a team
          </h2>
          <AddTeamForm leagueId={league.id} leagueCode={league.code} />
        </div>
      ) : null}

      {rows.length ? (
        <LeaderboardTable rows={rows} highlightId={mine?.id} />
      ) : (
        <Empty title="Nobody here yet">
          Share the code above and this board fills up.
        </Empty>
      )}

      {teamStandings.length > 0 ? (
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">
            Team standings
          </h2>
          <TeamStandings standings={teamStandings} />
        </div>
      ) : null}

      <p className="text-xs text-muted">
        Shows top-performing players for this season, not a judgement of investing
        skill.
      </p>

      {mine ? (
        <LeagueChat
          leagueId={league.id}
          myPortfolioId={mine.id}
          isAdmin={!!profile?.is_admin}
          initialMessages={messages}
          myTeam={myTeam}
        />
      ) : null}
    </div>
  );
}
