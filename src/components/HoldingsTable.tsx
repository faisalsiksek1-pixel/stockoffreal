import { money, percent, shares as fmtShares, toneClass } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import type { ValuedHolding } from "@/lib/types";

/**
 * Holdings list. Cards on mobile, table on desktop — a seven-column table is
 * unreadable on a phone, and this app is phone-first.
 *
 * `shares` is a signed net position (negative is short). Shares and weight are
 * shown as magnitudes with a SHORT badge carrying the direction, rather than a
 * bare negative number a reader would have to interpret — marketValue and P/L
 * are left signed since a negative there correctly reads as a liability/loss.
 */
function ShortBadge() {
  return <Badge tone="down">Short</Badge>;
}

export function HoldingsTable({ holdings }: { holdings: ValuedHolding[] }) {
  return (
    <>
      <ul className="space-y-2 md:hidden">
        {holdings.map((h) => (
          <li key={h.symbol} className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold">{h.symbol}</span>
                  {h.isShort ? <ShortBadge /> : null}
                </div>
                <div className="truncate text-xs text-muted">{h.name}</div>
              </div>
              <div className="text-right">
                <div className="tnum font-semibold">{money(h.marketValue)}</div>
                <div className={`tnum text-xs ${toneClass(h.pnl)}`}>
                  {money(h.pnl)} ({percent(h.pnlPct)})
                </div>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-muted">Shares</dt>
                <dd className="tnum">{fmtShares(Math.abs(h.shares))}</dd>
              </div>
              <div>
                <dt className="text-muted">Avg cost</dt>
                <dd className="tnum">{money(h.avgCost)}</dd>
              </div>
              <div>
                <dt className="text-muted">Price</dt>
                <dd className="tnum">{money(h.price)}</dd>
              </div>
            </dl>
            <div className="mt-2 text-xs text-muted">
              {(Math.abs(h.weight) * 100).toFixed(1)}% of portfolio
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-hidden rounded-2xl border border-line md:block">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-2xs uppercase tracking-widest text-muted">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Stock</th>
              <th className="px-4 py-3 text-right font-semibold">Shares</th>
              <th className="px-4 py-3 text-right font-semibold">Avg cost</th>
              <th className="px-4 py-3 text-right font-semibold">Price</th>
              <th className="px-4 py-3 text-right font-semibold">Value</th>
              <th className="px-4 py-3 text-right font-semibold">P/L</th>
              <th className="px-4 py-3 text-right font-semibold">Weight</th>
            </tr>
          </thead>
          <tbody className="bg-surface">
            {holdings.map((h) => (
              <tr key={h.symbol} className="border-t border-line">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold">{h.symbol}</span>
                    {h.isShort ? <ShortBadge /> : null}
                  </div>
                  <div className="text-xs text-muted">{h.name}</div>
                </td>
                <td className="tnum px-4 py-3 text-right">{fmtShares(Math.abs(h.shares))}</td>
                <td className="tnum px-4 py-3 text-right">{money(h.avgCost)}</td>
                <td className="tnum px-4 py-3 text-right">{money(h.price)}</td>
                <td className="tnum px-4 py-3 text-right font-semibold">
                  {money(h.marketValue)}
                </td>
                <td className={`tnum px-4 py-3 text-right ${toneClass(h.pnl)}`}>
                  {money(h.pnl)}
                  <div className="text-xs">{percent(h.pnlPct)}</div>
                </td>
                <td className="tnum px-4 py-3 text-right text-muted">
                  {(Math.abs(h.weight) * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
