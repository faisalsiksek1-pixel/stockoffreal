import { percent, toneClass } from "@/lib/format";
import type { TeamStanding } from "@/lib/types";

/**
 * Team-vs-team standings, alongside the individual leaderboard. Same plain
 * divided-row anatomy as LeaderboardTable — not a distinct visual language
 * for what is fundamentally the same kind of ranked list.
 *
 * Renders nothing for a league with no teams (the public league, 1v1 AI
 * duels) rather than an empty shell.
 */
export function TeamStandings({ standings }: { standings: TeamStanding[] }) {
  if (standings.length === 0) return null;

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {standings.map((team) => (
        <li key={team.teamId} className="flex items-center gap-3 px-3 py-3 sm:px-4">
          <span className="tnum w-8 shrink-0 text-center text-sm font-semibold text-muted">
            {team.rank}
          </span>

          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{team.teamName}</div>
            <div className="text-xs text-muted">
              {team.memberCount === 1 ? "1 member" : `${team.memberCount} members`}
            </div>
          </div>

          <div className={`tnum font-semibold ${toneClass(team.avgReturnPct)}`}>
            {percent(team.avgReturnPct)}
          </div>
        </li>
      ))}
    </ul>
  );
}
