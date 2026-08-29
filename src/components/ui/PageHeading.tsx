import type { ReactNode } from "react";

/** The one page-title style used by every in-app list/detail page. Auth
 *  pages (login/signup/welcome) intentionally keep their own larger,
 *  non-responsive heading — they're centered single-column heroes, not
 *  list pages, so they don't use this. */
export function PageHeading({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h1 className={`text-2xl font-extrabold tracking-tight sm:text-3xl ${className}`}>{children}</h1>;
}
