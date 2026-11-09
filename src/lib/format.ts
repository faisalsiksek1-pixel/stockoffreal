export function money(value: number, dp = 2): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Compact form for big headline numbers on narrow screens. */
export function moneyShort(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  // Leveraged positions let cash go negative (margin debt) — the sign has to
  // go before the $, not between it and the digits ("$-2.00M").
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  return money(value);
}

export function percent(value: number, dp = 2): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(dp)}%`;
}

export function shares(value: number): string {
  // Strips the decimal point too when every fractional digit is a trailing
  // zero (e.g. floating-point drift landing a share count at 9.999999 =>
  // "10.0000") — a bare /0+$/ left a dangling "10." behind.
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, "");
}

/** Short local clock time for a chat row — deliberately absolute, not
 *  relative: a "2m ago" label would need its own re-render interval to stay
 *  accurate, on top of the polling interval it already sits inside. */
export function chatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Tailwind text colour for a signed number. Neutral at exactly zero. */
export function toneClass(value: number): string {
  if (value > 0) return "text-up";
  if (value < 0) return "text-down";
  return "text-muted";
}
