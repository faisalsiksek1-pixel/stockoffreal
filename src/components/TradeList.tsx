import { money, shares as fmtShares } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import type { Trade } from "@/lib/types";

// buy/cover spend cash to open or reduce a position; sell/short credit it —
// same grouping TradePanel uses, kept here for the badge tone.
const SPENDS_CASH = new Set(["buy", "cover"]);

export function TradeList({ trades }: { trades: Trade[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {trades.map((t) => (
        <li key={t.id} className="flex items-center gap-3 px-4 py-3">
          <Badge tone={SPENDS_CASH.has(t.side) ? "up" : "down"}>{t.side}</Badge>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">
              {fmtShares(t.shares)} {t.symbol}
            </div>
            <div className="text-xs text-muted">
              {new Date(t.createdAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}{" "}
              at {money(t.price)}
            </div>
          </div>
          <div className="tnum text-sm font-semibold">{money(t.amount)}</div>
        </li>
      ))}
    </ul>
  );
}
