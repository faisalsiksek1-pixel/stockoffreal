import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { cache } from "react";

/** Must match middleware.ts's TRUSTED_USER_HEADER exactly. */
const TRUSTED_USER_HEADER = "x-stockoff-verified-uid";

/** Request-scoped client that respects the signed-in user and RLS. */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: { name: string; value: string; options?: CookieOptions }[]) => {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components cannot set cookies; middleware refreshes the
            // session instead, so ignoring this is correct rather than a bug.
          }
        },
      },
    },
  );
}

/** The signed-in user's id, memoized for the lifetime of one request's render.
 *  Every page-load helper that needs "who is this" (fillDueOrders,
 *  getMyPortfolio, getMyCompetitions, getMyProfile, checkRankChange,
 *  markChatRead) independently called supabase.auth.getUser() — a real
 *  network round trip to Supabase Auth, not a local cookie read — so a
 *  single dashboard load paid for it 5-6 times over. cache() collapses that
 *  to at most one call per request.
 *
 *  Middleware (see middleware.ts) already pays for exactly one verified
 *  auth.getUser() call per request to gate the route, and forwards the id it
 *  found through TRUSTED_USER_HEADER — a header it strips from every
 *  incoming request before setting it itself, so it cannot be forged by a
 *  client. When present, this trusts it instead of paying for a second,
 *  redundant round trip; every caller here only ever reads `.id`; falls back
 *  to a real getUser() call when the header is absent (e.g. middleware ran
 *  before this code was deployed, or some future route bypasses it), so this
 *  is a pure optimization, never a weaker check than before. */
export const getCurrentUser = cache(async (): Promise<{ id: string } | null> => {
  const h = await headers();
  const trustedId = h.get(TRUSTED_USER_HEADER);
  if (trustedId) return { id: trustedId };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * Service-role client. Bypasses RLS entirely, so it is only for trusted
 * server-side work: seeding, and admin actions after an explicit is_admin check.
 * Never import this into anything that runs in the browser.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set.");

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
