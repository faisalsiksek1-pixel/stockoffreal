import Link from "next/link";

import { AuthForm } from "@/components/AuthForm";
import { Alert } from "@/components/ui/Alert";
import { Wordmark } from "@/components/Wordmark";

export const metadata = { title: "Sign in - StockOff" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <Link href="/" className="mb-8 inline-block">
        <Wordmark className="text-xl" />
      </Link>
      {/* Intentionally not PageHeading — a centered auth hero, not a list page. */}
      <h1 className="text-3xl font-extrabold tracking-tight">Sign in</h1>

      {/* The OAuth callback redirects here with ?error= when the round trip
          fails; without this the form would render as if nothing had happened.
          Length-capped so a crafted URL cannot inject a wall of text. */}
      {error ? (
        <div className="mt-6">
          <Alert>{error.slice(0, 200)}</Alert>
        </div>
      ) : null}

      <div className="mt-7">
        <AuthForm mode="login" next={next} />
      </div>
    </div>
  );
}
