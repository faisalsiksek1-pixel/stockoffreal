import { Sparkline } from "@/components/Sparkline";
import { Badge } from "@/components/ui/Badge";
import { money, percent, toneClass } from "@/lib/format";

/**
 * The hero's right-side visual: a static mock of the real dashboard, built
 * from the same primitives (Sparkline, Badge, tnum) and the same $100K
 * starting balance as an actual account, so it reads as a preview of the
 * product rather than a decorative stock illustration.
 *
 * Numbers are fixed, not live — $108,421 is exactly +8.42% on $100,000,
 * matching the "#1 YOU +8.42%" row below it.
 */
const CHART_POINTS = [
  100000, 100600, 100200, 101400, 101100, 102300, 101900, 103400, 104200,
  103800, 105300, 104900, 106400, 106000, 107100, 106700, 107900, 108421,
];

const BOARD = [
  { rank: 1, handle: "YOU", change: 0.0842, isYou: true },
  { rank: 2, handle: "MOHAMMED", change: 0.0793, isYou: false },
  { rank: 3, handle: "ZAYED", change: 0.0618, isYou: false },
] as const;

export function LandingHeroPreview() {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-semibold uppercase tracking-widest text-muted">
          Your portfolio
        </span>
        <Badge tone="ai">Rank #1</Badge>
      </div>

      <div className="tnum mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">
        {money(108_421, 0)}
      </div>
      <div className="tnum mt-1 text-sm font-medium">
        <span className="text-muted">Today </span>
        <span className="text-up">{percent(0.0241)}</span>
      </div>

      <Sparkline points={CHART_POINTS} height={72} className="mt-4" />

      <div className="mt-5 space-y-2.5 border-t border-line pt-4">
        {BOARD.map((row) => (
          <div key={row.handle} className="flex items-center gap-3 text-sm">
            <span className="tnum w-4 text-muted">{row.rank}</span>
            <span className={`flex-1 font-semibold ${row.isYou ? "text-fg" : "text-muted"}`}>
              {row.handle}
            </span>
            <span className={`tnum font-semibold ${toneClass(row.change)}`}>
              {percent(row.change)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
