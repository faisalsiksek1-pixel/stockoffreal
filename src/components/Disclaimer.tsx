export const DISCLAIMER_TEXT =
  "StockOff is a simulated investing game. It does not involve real money and does not provide financial advice. Simulated results do not represent guaranteed real-world performance.";

export function Disclaimer({ className = "" }: { className?: string }) {
  return <p className={`text-xs leading-relaxed text-muted ${className}`}>{DISCLAIMER_TEXT}</p>;
}
