import Link from "next/link";

import { Disclaimer } from "@/components/Disclaimer";
import { LandingHeroPreview } from "@/components/LandingHeroPreview";
import { Wordmark } from "@/components/Wordmark";

const STEPS = [
  {
    n: "01",
    title: "Get $100K",
    body: "Start with $100,000 in virtual cash. No experience or real money required.",
  },
  {
    n: "02",
    title: "Build your portfolio",
    body: "Trade using real market data, same as any real brokerage.",
  },
  {
    n: "03",
    title: "Beat everyone",
    body: "Outperform your friends and the StockOff AI on a live leaderboard.",
  },
] as const;

type TickerItem =
  | { rank: number; handle: string; change: number }
  | { status: string };

const TICKER: TickerItem[] = [
  { rank: 1, handle: "YUSUF", change: 12.4 },
  { rank: 2, handle: "AI", change: 10.8 },
  { rank: 3, handle: "ZAYED", change: 8.9 },
  { status: "MARKET OPEN" },
];

export default function LandingPage() {
  return (
    <div className="relative overflow-x-clip">
      {/* Decoration only — sits behind everything, never intercepts clicks. */}
      <div className="hero-glow bg-grid pointer-events-none absolute inset-x-0 top-0 h-[640px]" aria-hidden />

      <div className="relative mx-auto max-w-6xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
        <header className="flex items-center justify-between">
          <Wordmark className="text-xl" />
          <nav className="flex items-center gap-5">
            <Link
              href="/leaderboard"
              className="hidden text-sm font-medium text-muted hover:text-fg sm:block"
            >
              Leaderboard
            </Link>
            <Link href="/login" className="text-sm font-medium text-muted hover:text-fg">
              Sign in
            </Link>
          </nav>
        </header>

        <section className="grid gap-14 pt-14 sm:pt-20 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-16">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-ai">
              <span className="h-1.5 w-1.5 rounded-full bg-ai" />
              StockOff League is live
            </div>

            <h1 className="text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl">
              The stock market, turned into <span className="text-ai">a game</span>.
            </h1>

            <p className="mt-6 max-w-lg text-lg font-medium leading-snug text-fg/90 sm:text-xl">
              Start with $100K. Build your portfolio. Beat your friends and the AI.
            </p>

            <div className="mt-8">
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 rounded-xl bg-ai px-6 py-3.5 text-base font-semibold text-on-accent transition hover:opacity-90"
              >
                Start trading
                <span aria-hidden>→</span>
              </Link>
            </div>
          </div>

          <LandingHeroPreview />
        </section>

        {/* Scrolling ticker strip — pure decoration, purely to feel alive. */}
        <div
          className="mt-14 -mx-5 overflow-hidden border-y border-line/70 bg-surface/50 py-2.5 backdrop-blur sm:-mx-8"
          aria-hidden
        >
          <div className="animate-marquee flex w-max gap-8 px-5 sm:px-8">
            {[...TICKER, ...TICKER].map((t, i) =>
              "status" in t ? (
                <span
                  key={`status-${i}`}
                  className="flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-ai"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-ai" />
                  {t.status}
                </span>
              ) : (
                <span
                  key={`${t.handle}-${i}`}
                  className="tnum flex shrink-0 items-center gap-1.5 text-xs font-semibold text-muted"
                >
                  <span className="text-muted">#{t.rank}</span>
                  <span className="text-fg">{t.handle}</span>
                  <span className="text-up">+{t.change.toFixed(1)}%</span>
                </span>
              ),
            )}
          </div>
        </div>

        <section className="pt-16 sm:pt-20">
          <h2 className="mb-8 text-xs font-semibold uppercase tracking-widest text-muted">
            How it works
          </h2>
          <ol className="grid gap-8 sm:grid-cols-3 sm:gap-0">
            {STEPS.map((step, i) => (
              <li
                key={step.n}
                className={
                  i === 0
                    ? ""
                    : "border-t border-line pt-5 sm:border-t-0 sm:border-l sm:pl-8 sm:pt-0"
                }
              >
                <div className="tnum text-sm font-semibold text-ai">{step.n}</div>
                <div className="mt-3 text-base font-semibold">{step.title}</div>
                <div className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</div>
              </li>
            ))}
          </ol>
        </section>

        <footer className="mt-16 border-t border-line pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Wordmark className="text-sm" />
            <div className="flex gap-4 text-xs font-medium text-muted">
              <Link href="/leaderboard" className="hover:text-fg">
                Leaderboard
              </Link>
              <Link href="/login" className="hover:text-fg">
                Sign in
              </Link>
            </div>
          </div>
          <Disclaimer className="mt-3 max-w-2xl" />
        </footer>
      </div>
    </div>
  );
}
