"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

/**
 * Signup, login, logout, and Google sign-in.
 *
 * Signup calls the bootstrap_new_user SQL function, which creates the profile,
 * funds the portfolio and joins the public league in one transaction. Doing
 * those as three separate client calls would leave half-created accounts behind
 * whenever one failed.
 *
 * Google sign-in cannot do that in one step: OAuth returns an email and a name,
 * never a username, and a username is required — it is what the leaderboard
 * displays. So the Google path is two stages. The provider creates the auth user,
 * then /welcome collects a username and runs the same bootstrap. Between those
 * two stages a session exists with no profile, which every signed-in page has to
 * tolerate; they redirect to /welcome rather than assuming a portfolio.
 */

const UsernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,20}$/, "3–20 characters: letters, numbers, underscores.");

const SignupSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
  username: UsernameSchema,
});

export type AuthResult = { ok: false; error: string } | { ok: true };

function isAdminEmail(email: string): boolean {
  const allowed = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

export async function signUp(formData: FormData): Promise<AuthResult> {
  const parsed = SignupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    username: formData.get("username"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid details." };
  }
  const { email, password, username } = parsed.data;

  const supabase = await createClient();

  // Check the username before creating the auth user, so a clash does not leave
  // an orphaned account with no profile.
  const { data: taken } = await supabase
    .from("profiles")
    .select("username")
    .ilike("username", username)
    .maybeSingle();
  if (taken) return { ok: false, error: "That username is taken." };

  const { error: signUpError } = await supabase.auth.signUp({ email, password });
  if (signUpError) return { ok: false, error: signUpError.message };

  const { error: bootstrapError } = await supabase.rpc("bootstrap_new_user", {
    p_username: username,
    p_is_admin: isAdminEmail(email),
  });

  if (bootstrapError) {
    // Most likely cause: email confirmation is on, so there is no session yet
    // and auth.uid() is null inside the function.
    return {
      ok: false,
      error:
        "Account created but setup failed. If email confirmation is enabled in Supabase, confirm your email then sign in.",
    };
  }

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function signIn(formData: FormData): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { ok: false, error: "Enter your email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: "Those details do not match an account." };

  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * The absolute origin to send OAuth back to.
 *
 * Prefers NEXT_PUBLIC_SITE_URL so the value is explicit in production, and falls
 * back to the request's own host header, which keeps local development and Vercel
 * preview deployments working without per-environment configuration.
 */
async function siteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Whether the Google provider is actually configured on the auth service. */
async function googleEnabled(): Promise<boolean> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) return false;

  try {
    const res = await fetch(`${base}/auth/v1/settings`, {
      headers: { apikey: key },
      // Deliberately uncached. A cache here means enabling the provider in
      // Supabase appears not to work until the cache expires — which is exactly
      // what happened while wiring this up. One small request on an explicit
      // click is nothing next to the OAuth round trip it guards.
      cache: "no-store",
    });
    if (!res.ok) return false;
    const settings = (await res.json()) as { external?: Record<string, boolean> };
    return settings.external?.google === true;
  } catch {
    // Never block sign-in on a failed probe — fall through and let the OAuth
    // round trip report the real problem.
    return true;
  }
}

/**
 * Begin Google sign-in. Redirects the browser to Google; the round trip comes
 * back to /auth/callback, which exchanges the code for a session.
 */
export async function signInWithGoogle(next?: string): Promise<AuthResult> {
  // Pre-flight, because signInWithOAuth is not a reliable failure signal: it
  // returns a URL whether or not the provider is configured, so a disabled
  // provider would redirect the user to Supabase and show them raw JSON —
  // {"code":400,...,"msg":"Unsupported provider: provider is not enabled"}.
  // Asking the auth service what is enabled turns that into an in-app message.
  if (!(await googleEnabled())) {
    return {
      ok: false,
      error:
        "Google sign-in is not set up yet. Enable the Google provider in Supabase under Authentication → Providers.",
    };
  }

  const supabase = await createClient();
  const origin = await siteOrigin();

  // Only relative paths are forwarded, so a crafted ?next= cannot bounce someone
  // to another origin after signing in.
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(safeNext)}`,
      queryParams: { prompt: "select_account" },
    },
  });

  if (error || !data?.url) {
    return {
      ok: false,
      error:
        error?.message ??
        "Google sign-in is unavailable. Check the Google provider is enabled in Supabase.",
    };
  }

  // redirect() throws, so it must sit outside any try/catch.
  redirect(data.url);
}

/**
 * Stage two of Google sign-in: the caller already has a session but no profile.
 * Runs the same bootstrap the email signup uses.
 */
export async function completeProfile(formData: FormData): Promise<AuthResult> {
  const parsed = UsernameSchema.safeParse(formData.get("username"));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid username." };
  }
  const username = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Your session expired. Sign in again." };

  // Already bootstrapped — treat as success so a double submit is harmless.
  const { data: mine } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();
  if (mine) return { ok: true };

  const { data: taken } = await supabase
    .from("profiles")
    .select("username")
    .ilike("username", username)
    .maybeSingle();
  if (taken) return { ok: false, error: "That username is taken." };

  const { error } = await supabase.rpc("bootstrap_new_user", {
    p_username: username,
    p_is_admin: isAdminEmail(user.email ?? ""),
  });
  if (error) {
    return {
      ok: false,
      error: error.message.includes("No active season")
        ? "No season is running yet. Ask an admin to open one."
        : "Could not finish setting up your account. Try again.",
    };
  }

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}
