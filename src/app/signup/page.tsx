import Link from "next/link";

import { AuthForm } from "@/components/AuthForm";
import { Wordmark } from "@/components/Wordmark";

export const metadata = { title: "Start with $100K - StockOff" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <Link href="/" className="mb-8 inline-block">
        <Wordmark className="text-xl" />
      </Link>
      {/* Intentionally not PageHeading — a centered auth hero, not a list page. */}
      <h1 className="text-3xl font-extrabold tracking-tight">Start with $100,000</h1>
      <p className="mt-2 text-sm text-muted">
        Pick a username, and you are straight into StockOff League.
      </p>
      <div className="mt-7">
        <AuthForm mode="signup" next={next} />
      </div>
    </div>
  );
}
