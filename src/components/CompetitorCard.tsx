import { money, percent, toneClass } from "@/lib/format";
import type { OwnerType, ValuedPortfolio } from "@/lib/types";

/**
 * AI and Market get their own identity colours so the race is readable at a
 * glance. Green and red stay reserved for returns, never identity.
 */
const IDENTITY: Partial<
  Record<OwnerType, { label: string; accent: string; ring: string; tone: "ai" | "market" | "neutral" }>
> = {
  ai: { label: "AI", accent: "text-ai", ring: "border-ai/40", tone: "ai" },
  benchmark: { label: "Market", accent: "text-market", ring: "border-market/40", tone: "market" },
  user: { label: "Player", accent: "text-fg", ring: "border-line", tone: "neutral" },
};
const DEFAULT_IDENTITY = { label: "Player", accent: "text-fg", ring: "border-line", tone: "neutral" as const };

export function competitorIdentity(ownerType: OwnerType) {
  return IDENTITY[ownerType] ?? DEFAULT_IDENTITY;
}

export function CompetitorCard({ portfolio }: { portfolio: ValuedPortfolio }) {
  const id = competitorIdentity(portfolio.ownerType);

  return (
    <div className={`rounded-2xl border bg-surface p-4 ${id.ring}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-xs font-semibold uppercase tracking-widest ${id.accent}`}>
          {id.label}
        </span>
        <span className="truncate text-xs text-muted">{portfolio.displayName}</span>
      </div>
      <div
        className={`tnum mt-2 text-2xl font-semibold tracking-tight ${toneClass(portfolio.totalReturnPct)}`}
      >
        {percent(portfolio.totalReturnPct)}
      </div>
      <div className="tnum mt-0.5 text-xs text-muted">{money(portfolio.totalValue, 0)}</div>
    </div>
  );
}
