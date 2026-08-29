"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Mobile-first primary navigation. Hidden on desktop, where the header takes over. */
const TABS = [
  { href: "/dashboard", label: "Home" },
  { href: "/trade", label: "Trade" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/leagues", label: "Leagues" },
  { href: "/profile", label: "Profile" },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-5">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 py-2.5 text-2xs font-medium transition ${
                  active ? "text-fg" : "text-muted"
                }`}
              >
                <span
                  className={`h-1 w-6 rounded-full transition ${active ? "bg-ai" : "bg-transparent"}`}
                />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
