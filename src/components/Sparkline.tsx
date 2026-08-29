"use client";

import { useId } from "react";

/**
 * Inline SVG sparkline. No charting library: one dependency-free component
 * covers every chart the MVP needs, and it renders on the server.
 */
export function Sparkline({
  points,
  className = "",
  height = 64,
}: {
  points: number[];
  className?: string;
  height?: number;
}) {
  const gradientId = useId();

  if (points.length < 2) {
    return (
      <div className={`flex items-center text-xs text-muted ${className}`} style={{ height }}>
        Not enough history yet.
      </div>
    );
  }

  const width = 300;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  // A flat series would divide by zero; give it a nominal band so the line
  // renders through the middle instead of vanishing.
  const span = hi - lo || Math.abs(hi) * 0.02 || 1;

  const coords = points.map((p, i) => ({
    x: (i / (points.length - 1)) * width,
    y: height - 4 - ((p - lo) / span) * (height - 8),
  }));

  const path = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${path} L${width},${height} L0,${height} Z`;
  const last = coords[coords.length - 1]!;

  const rising = (points.at(-1) ?? 0) >= (points[0] ?? 0);
  const stroke = rising ? "var(--color-up)" : "var(--color-down)";
  const fillId = `spark-fill-${gradientId}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`w-full overflow-visible ${className}`}
      style={{ height }}
      role="img"
      aria-label={rising ? "Trending up" : "Trending down"}
    >
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${fillId})`} stroke="none" />
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last.x} cy={last.y} r="6" fill={stroke} opacity="0.18" />
      <circle cx={last.x} cy={last.y} r="2.5" fill={stroke} />
    </svg>
  );
}
