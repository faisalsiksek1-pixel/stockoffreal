import type { ReactNode } from "react";

type Tone = "up" | "down" | "ai" | "market" | "neutral";

const TONE: Record<Tone, string> = {
  up: "border-up/40 bg-up/15 text-up",
  down: "border-down/40 bg-down/15 text-down",
  ai: "border-ai/40 bg-ai/15 text-ai",
  market: "border-market/40 bg-market/15 text-market",
  neutral: "border-line bg-surface-2 text-fg",
};

/** Small status/identity tag — short position, trade side, competitor
 *  identity, "You", "Admin". One anatomy for all of them. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}
