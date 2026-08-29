"use client";

import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { money, percent, toneClass } from "@/lib/format";

export interface PricePoint {
  /** Day index (see lib/market/mock.ts's dayIndex) — days since the Unix epoch. */
  t: number;
  price: number;
}

const RANGES = [
  { value: "1W", days: 7 },
  { value: "1M", days: 30 },
  { value: "3M", days: 90 },
  { value: "1Y", days: 365 },
] as const;

type Range = (typeof RANGES)[number]["value"];

// Mirrors the tokens in globals.css. A <canvas>-based chart can't read
// Tailwind's CSS custom properties directly, so the values are duplicated
// here — this app is dark-only, so there is no second theme to keep in sync.
const COLOR = {
  line: "#1f2b54",
  muted: "#8d9dc2",
  fg: "#eaeff9",
  up: "#35cf97",
  down: "#f2565c",
};

/**
 * A real trading chart, not a hand-drawn preview: built on lightweight-charts
 * (TradingView's own open-source engine) instead of another inline SVG, so it
 * gets a proper price axis, time axis, native crosshair with axis-anchored
 * labels, and pan/zoom for free. Sparkline stays hand-rolled SVG for the
 * small static previews elsewhere (landing, portfolio) — this is the one
 * place a real chart earns its dependency.
 *
 * The full year of history is set once; the 1W/1M/3M/1Y toggle moves the
 * visible window with `setVisibleLogicalRange` rather than re-fetching or
 * re-slicing data, and the user can still scroll/zoom past it like a real
 * chart.
 */
export function PriceChart({
  history,
  height = 260,
}: {
  history: PricePoint[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const [range, setRange] = useState<Range>("1M");
  const [hover, setHover] = useState<{ price: number; time: number } | null>(null);

  const data = useMemo(
    () => history.map((p) => ({ time: (p.t * 86_400) as UTCTimestamp, value: p.price })),
    [history],
  );

  // Mount once: create the chart and the area series.
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
        // Magnet, not Normal: the horizontal line and its axis label snap to
        // the series' actual value at that time, so the axis label always
        // agrees with the price shown in the header above the chart.
        mode: CrosshairMode.Magnet,
        vertLine: { color: COLOR.muted, width: 1, style: LineStyle.Dashed, labelBackgroundColor: COLOR.muted },
        horzLine: { color: COLOR.muted, width: 1, style: LineStyle.Dashed, labelBackgroundColor: COLOR.muted },
      },
      rightPriceScale: { borderColor: COLOR.line },
      timeScale: { borderColor: COLOR.line, timeVisible: false },
      handleScroll: { vertTouchDrag: false },
    });

    const series = chart.addSeries(AreaSeries, {
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 4,
    });

    chart.subscribeCrosshairMove((param) => {
      const point = param.seriesData.get(series);
      if (point && "value" in point && typeof param.time === "number") {
        setHover({ price: point.value, time: param.time });
      } else {
        setHover(null);
      }
    });

    const resize = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth });
    });
    resize.observe(container);

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // Deliberately empty deps: the chart is created once and torn down on
    // unmount; data and range changes are pushed into it by the two effects
    // below rather than recreating the chart.
  }, []);

  // Data changes when the selected symbol changes (history is swapped, chart stays mounted).
  useEffect(() => {
    seriesRef.current?.setData(data);
  }, [data]);

  // Range toggle moves the visible window; up/down colouring follows the
  // trend over that window, same rule Sparkline uses.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || data.length < 2) return;

    const days = RANGES.find((r) => r.value === range)!.days;
    const from = Math.max(0, data.length - days);
    chart.timeScale().setVisibleLogicalRange({ from, to: data.length - 1 });

    const windowData = data.slice(-days);
    const rising = windowData[windowData.length - 1]!.value >= windowData[0]!.value;
    const stroke = rising ? COLOR.up : COLOR.down;
    series.applyOptions({
      lineColor: stroke,
      topColor: `${stroke}44`,
      bottomColor: `${stroke}00`,
    });
  }, [range, data]);

  if (data.length < 2) {
    return (
      <div className="flex items-center text-xs text-muted" style={{ height }}>
        Not enough history yet.
      </div>
    );
  }

  const latest = data[data.length - 1]!;
  const windowStart = data[Math.max(0, data.length - RANGES.find((r) => r.value === range)!.days)]!;
  const displayPrice = hover?.price ?? latest.value;
  const changePct = (displayPrice - windowStart.value) / windowStart.value;
  const displayDate = new Date((hover?.time ?? latest.time) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: range === "3M" || range === "1Y" ? "numeric" : undefined,
  });

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="tnum text-lg font-semibold" style={{ color: COLOR.fg }}>
            {money(displayPrice)}
          </div>
          <div className="tnum text-xs">
            <span className={toneClass(changePct)}>{percent(changePct)}</span>{" "}
            <span className="text-muted">{displayDate}</span>
          </div>
        </div>
        <SegmentedControl
          fullWidth={false}
          options={RANGES.map((r) => ({ value: r.value, label: r.value }))}
          value={range}
          onChange={setRange}
        />
      </div>

      <div ref={containerRef} className="mt-2" />
    </div>
  );
}
