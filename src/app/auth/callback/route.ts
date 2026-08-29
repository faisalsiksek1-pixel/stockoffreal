import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * OAuth return leg.
 *
 * Google sends the browser here with a one-time code. Exchanging it sets the
 * session cookies, after which the user either has a profile already (returning
 * player → straight in) or does not (first Google sign-in → /welcome to pick a
 * username, because OAuth never supplies one).
 *
 * This must stay a route handler rather than a page: exchangeCodeForSession
 * writes cookies, and Server Components cannot set them.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  // The user pressed "cancel" on Google's consent screen. Not an error worth
  // showing — just put them back where they started.
  if (oauthError) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/login?error=Sign-in%20link%20was%20incomplete.", url.origin),
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      new URL("/login?error=Could%20not%20complete%20sign-in.", url.origin),
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      new URL("/login?error=Could%20not%20complete%20sign-in.", url.origin),
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    return NextResponse.redirect(new URL("/welcome", url.origin));
  }

  // Relative paths only, so ?next= cannot redirect off-site after sign-in.
  const next = url.searchParams.get("next");
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  return NextResponse.redirect(new URL(target, url.origin));
}
