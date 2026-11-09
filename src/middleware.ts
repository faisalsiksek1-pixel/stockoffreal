import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase session on every request and gates private routes.
 *
 * Route protection lives here so an unauthenticated request never reaches a page
 * that assumes a user. Pages still check, but this avoids a flash of protected
 * layout before a client-side redirect.
 */

const PRIVATE = ["/dashboard", "/trade", "/portfolio", "/leagues", "/profile", "/share", "/admin", "/welcome"];

// Carries the id this middleware already verified via a real auth.getUser()
// call forward to the render tree, so getCurrentUser() (lib/supabase/server.ts)
// can skip paying for that same network round trip a second time. Safe only
// because this file is the sole writer: stripped unconditionally from every
// incoming request below, before being set from the verified `user`, so a
// client cannot forge it to impersonate another id.
const TRUSTED_USER_HEADER = "x-stockoff-verified-uid";

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(TRUSTED_USER_HEADER);

  const cookiesToSet: { name: string; value: string; options?: CookieOptions }[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet: { name: string; value: string; options?: CookieOptions }[]) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          cookiesToSet.push(...toSet);
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (!user && PRIVATE.some((p) => path.startsWith(p))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  // Signed-in users have no reason to see the marketing or auth pages.
  if (user && (path === "/login" || path === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (user) requestHeaders.set(TRUSTED_USER_HEADER, user.id);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)"],
};
