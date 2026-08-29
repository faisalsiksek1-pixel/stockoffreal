import { redirect } from "next/navigation";

import { Disclaimer } from "@/components/Disclaimer";
import { UsernameForm } from "@/components/UsernameForm";
import { Wordmark } from "@/components/Wordmark";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Pick a username - StockOff" };
export const dynamic = "force-dynamic";

/** Turn a Google display name or email into a plausible username suggestion. */
function suggest(name: string | undefined, email: string | undefined): string {
  const base = (name ?? email?.split("@")[0] ?? "").toLowerCase();
  const cleaned = base.replace(/[^a-z0-9_]/g, "").slice(0, 20);
  return cleaned.length >= 3 ? cleaned : "";
}

export default async function WelcomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware guards this route, but a session can expire between the two.
  if (!user) redirect("/login");

  // Already bootstrapped — nothing to do here.
  const { data: profile } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();
  if (profile) redirect("/dashboard");

  const meta = user.user_metadata as { full_name?: string; name?: string } | null;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-12">
      <Wordmark className="text-2xl" />

      {/* Intentionally not PageHeading — a centered auth hero, not a list page. */}
      <h1 className="mt-6 text-3xl font-extrabold tracking-tight">
        One more thing
      </h1>
      <p className="mt-2 text-sm text-muted">
        You&rsquo;re signed in as {user.email}. Pick the name you want on the
        leaderboard and we&rsquo;ll fund your account with $100,000 in simulated
        money.
      </p>

      <div className="mt-7">
        <UsernameForm suggestion={suggest(meta?.full_name ?? meta?.name, user.email)} />
      </div>

      <div className="mt-10">
        <Disclaimer />
      </div>
    </div>
  );
}
