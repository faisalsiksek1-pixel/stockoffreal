import Link from "next/link";
import { redirect } from "next/navigation";

import { BottomNav } from "@/components/BottomNav";
import { Disclaimer } from "@/components/Disclaimer";
import { Wordmark } from "@/components/Wordmark";
import { getMyProfile } from "@/lib/queries";

const LINKS = [
  { href: "/dashboard", label: "Home" },
  { href: "/trade", label: "Trade" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/leagues", label: "Leagues" },
  { href: "/news", label: "News" },
] as const;

/** Shell for every signed-in page: desktop header, mobile bottom nav, footer. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const profile = await getMyProfile();

  // Middleware already redirects unauthenticated requests. This covers the case
  // where a session exists but signup never completed, so there is no profile.
  if (!profile) redirect("/welcome");

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-5 py-3.5">
          <Link href="/dashboard">
            <Wordmark className="text-lg" />
          </Link>
          <nav className="hidden flex-1 items-center gap-5 md:flex" aria-label="Primary">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-sm font-medium text-muted transition hover:text-fg"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {profile.is_admin ? (
              <Link href="/admin" className="text-sm font-medium text-ai hover:underline">
                Admin
              </Link>
            ) : null}
            <Link
              href="/profile"
              className="rounded-full border border-line px-3 py-1.5 text-sm font-medium hover:border-muted"
            >
              {profile.username}
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-28 pt-6 md:pb-16">{children}</main>

      <footer className="mx-auto max-w-5xl border-t border-line px-5 pb-28 pt-6 md:pb-10">
        <Disclaimer />
      </footer>

      <BottomNav />
    </div>
  );
}
