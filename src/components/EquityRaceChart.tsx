"use client";

import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import { competitorIdentity } from "@/components/CompetitorCard";
import { percent, toneClass } from "@/lib/format";
import type { OwnerType } from "@/lib/types";

export interface RaceSeries {
  id: string;
  ownerType: OwnerType;
  displayName: string;
  /** Oldest first; value is fractional return, e.g. 0.034 for +3.4%. */
  history: { t: number; value: number }[];
}

// Mirrors globals.css's --color-ai/--color-market/--color-fg — a <canvas>-based
// chart can't read Tailwind's CSS custom properties directly, same reasoning
// PriceChart's own COLOR object documents.
const LINE_COLOR: Partial<Record<OwnerType, string>> = {
  ai: "#2f6bff",
  benchmark: "#7c95c4",
  user: "#eaeff9",
};
const DEFAULT_LINE_COLOR = "#8d9dc2";

const COLOR = {
  line: "#1f2b54",
  muted: "#8d9dc2",
};

/**
 * Overlays each competitor's return curve on one chart — the head-to-head
 * "how did we get here" view above the CompetitorCard "today" snapshot.
 * Built on lightweight-charts like PriceChart, but with N LineSeries instead
 * of one AreaSeries, since there's no existing multi-series chart to reuse.
 *
 * The series list only changes between page loads (the dashboard renders
 * once per request, this component doesn't live through a symbol switch the
 * way PriceChart does), so the data effect just clears and re-adds every
 * series on each change rather than diffing incrementally.
 */
export function EquityRaceChart({ series, height = 200 }: { series: RaceSeries[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<ISeriesApi<"Line">[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLOR.muted,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: COLOR.line },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: COLOR.muted, width: 1, style: LineStyle.Dashed, labelBackgroundColor: COLOR.muted },
        horzLine: { color: COLOR.muted, width: 1, style: LineStyle.Dashed, labelBackgroundColor: COLOR.muted },
      },
      rightPriceScale: { borderColor: COLOR.line },
      timeScale: { borderColor: COLOR.line, timeVisible: false },
      handleScroll: { vertTouchDrag: false },
    });

    const resize = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    resize.observe(container);

    chartRef.current = chart;

    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRefs.current = [];
    };
    // Deliberately empty deps: the chart is created once and torn down on
    // unmount; series changes are pushed in by the effect below.
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    for (const s of seriesRefs.current) chart.removeSeries(s);
    seriesRefs.current = series.map((s) => {
      const line = chart.addSeries(LineSeries, {
        color: LINE_COLOR[s.ownerType] ?? DEFAULT_LINE_COLOR,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: "percent", precision: 2 },
      });
      line.setData(
        s.history.map((p) => ({ time: (p.t * 86_400) as UTCTimestamp, value: p.value * 100 })),
      );
      return line;
    });
  }, [series]);

  const hasEnoughHistory = series.some((s) => s.history.length >= 2);
  if (!hasEnoughHistory) {
    return (
      <div className="flex items-center text-xs text-muted" style={{ height }}>
        Not enough history yet.
      </div>
    );
  }

  return (
    <div>
      <div ref={containerRef} />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => {
          const id = competitorIdentity(s.ownerType);
          const latest = s.history.at(-1)?.value ?? 0;
          return (
            <div key={s.id} className="flex items-center gap-1.5 text-xs">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: LINE_COLOR[s.ownerType] ?? DEFAULT_LINE_COLOR }}
              />
              <span className={id.accent}>{id.label}</span>
              <span className={`tnum ${toneClass(latest)}`}>{percent(latest)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
