import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

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

/** The signed-in user, memoized for the lifetime of one request's render.
 *  Every page-load helper that needs "who is this" (fillDueOrders,
 *  getMyPortfolio, getMyCompetitions, getMyProfile, checkRankChange,
 *  markChatRead) independently called supabase.auth.getUser() — a real
 *  network round trip to Supabase Auth, not a local cookie read — so a
 *  single dashboard load paid for it 5-6 times over. cache() collapses
 *  that to one call per request; only the middleware's own getUser() (a
 *  separate Edge execution, before this render tree even starts) is
 *  outside its reach, and that one stays as-is deliberately: Supabase's
 *  own guidance is to use getUser() rather than the unverified getSession()
 *  for exactly this route-gating job. */
export const getCurrentUser = cache(async () => {
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
