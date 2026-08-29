import { competitorIdentity } from "@/components/CompetitorCard";
import { Badge } from "@/components/ui/Badge";
import { money, percent, toneClass } from "@/lib/format";
import type { LeaderboardRow } from "@/lib/types";

/**
 * The board. Special competitors are tinted with their identity colour and
 * labelled, so a player can tell at a glance whether they are above the AI.
 */
export function LeaderboardTable({
  rows,
  highlightId,
}: {
  rows: LeaderboardRow[];
  highlightId?: string;
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {rows.map((row) => {
        const special = row.ownerType !== "user";
        const id = competitorIdentity(row.ownerType);
        const isMe = row.portfolioId === highlightId;

        return (
          <li
            key={row.portfolioId}
            className={`flex items-center gap-3 px-3 py-3 sm:px-4 ${
              isMe ? "bg-ai/10" : special ? "bg-surface-2/60" : ""
            }`}
          >
            <span className="tnum w-8 shrink-0 text-center text-sm font-semibold text-muted">
              {row.rank}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`truncate font-semibold ${special ? id.accent : ""}`}>
                  {row.displayName}
                </span>
                {special ? <Badge tone={id.tone}>{id.label}</Badge> : null}
                {row.teamName ? <Badge tone="neutral">{row.teamName}</Badge> : null}
                {isMe ? <Badge tone="ai">You</Badge> : null}
              </div>
              <div className="tnum text-xs text-muted">{money(row.totalValue, 0)}</div>
            </div>

            <div className="text-right">
              <div className={`tnum font-semibold ${toneClass(row.totalReturnPct)}`}>
                {percent(row.totalReturnPct)}
              </div>
              <div className={`tnum text-xs ${toneClass(row.dayChangePct)}`}>
                {percent(row.dayChangePct)} today
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
