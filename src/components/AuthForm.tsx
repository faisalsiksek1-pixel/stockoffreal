"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { DISCLAIMER_TEXT } from "@/components/Disclaimer";
import { signIn, signInWithGoogle, signUp } from "@/actions/auth";

/**
 * One form for both signup and login. Client component because it owns
 * submission state; all validation is re-run on the server regardless.
 */
export function AuthForm({ mode, next }: { mode: "signup" | "login"; next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isSignup = mode === "signup";

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = isSignup ? await signUp(formData) : await signIn(formData);
      if (result.ok) {
        router.push(next && next.startsWith("/") ? next : "/dashboard");
        // Server Components cache the previous (signed-out) render; refresh
        // makes the dashboard reflect the new session immediately.
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  function onGoogle() {
    setError(null);
    startTransition(async () => {
      // On success this never returns — the action issues a redirect to Google.
      const result = await signInWithGoogle(next);
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {error ? <Alert>{error}</Alert> : null}

      {isSignup ? (
        <div>
          <label htmlFor="username" className="mb-1.5 block text-sm font-medium">
            Username
          </label>
          <Input
            id="username"
            name="username"
            required
            minLength={3}
            maxLength={20}
            pattern="[A-Za-z0-9_]+"
            autoComplete="username"
            placeholder="marketwizard"
          />
          <p className="mt-1.5 text-xs text-muted">
            3–20 characters. Letters, numbers and underscores. This is what other
            players see.
          </p>
        </div>
      ) : null}

      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={isSignup ? "new-password" : "current-password"}
          placeholder={isSignup ? "At least 8 characters" : "••••••••"}
        />
      </div>

      <Button type="submit" disabled={pending} className="w-full py-3.5 text-base">
        {pending ? "Working…" : isSignup ? "Start with $100K" : "Sign in"}
      </Button>

      <div className="flex items-center gap-3 py-1" aria-hidden>
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <Button
        type="button"
        variant="secondary"
        onClick={onGoogle}
        disabled={pending}
        className="w-full py-3.5 text-base"
      >
        <GoogleMark />
        Continue with Google
      </Button>

      {isSignup ? (
        <p className="text-xs leading-relaxed text-muted">{DISCLAIMER_TEXT}</p>
      ) : null}

      <p className="pt-1 text-center text-sm text-muted">
        {isSignup ? (
          <>
            Already playing?{" "}
            <Link href="/login" className="font-medium text-fg hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link href="/signup" className="font-medium text-fg hover:underline">
              Start with $100K
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

/** Google's mark, inlined so the button needs no network request to render. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
