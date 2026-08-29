"use client";

import type { ReactNode } from "react";

/** The small toggle-group pattern used for market/limit, dollars/shares,
 *  leverage, and similar mutually-exclusive option sets. */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  fullWidth = true,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  /** Segments split the available width evenly; off for a compact inline toggle. */
  fullWidth?: boolean;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-line p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${fullWidth ? "flex-1" : ""} ${
            value === opt.value ? "bg-surface-2 text-fg" : "text-muted"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
