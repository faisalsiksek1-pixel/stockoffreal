import { toneClass } from "@/lib/format";

/** A big headline number with a label. The unit of the dashboard. */
export function Stat({
  label,
  value,
  sub,
  tone,
  large = false,
}: {
  label: string;
  value: string;
  sub?: string;
  /** When supplied, colours the value green/red by sign. */
  tone?: number;
  large?: boolean;
}) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-widest text-muted">
        {label}
      </div>
      <div
        className={`tnum font-semibold tracking-tight ${large ? "text-3xl sm:text-4xl" : "text-xl sm:text-2xl"} ${tone === undefined ? "" : toneClass(tone)}`}
      >
        {value}
      </div>
      {sub ? <div className="tnum mt-0.5 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}
