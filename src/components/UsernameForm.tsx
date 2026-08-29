"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { completeProfile } from "@/actions/auth";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

/**
 * Stage two of Google sign-in: pick the name the leaderboard will show.
 *
 * `suggestion` is derived from the Google account so most people can accept it
 * and move on, but it is only ever a default — the server re-validates the
 * format and re-checks uniqueness regardless of what is submitted.
 */
export function UsernameForm({ suggestion }: { suggestion?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await completeProfile(formData);
      if (result.ok) {
        router.push("/dashboard");
        // The signed-out render is cached; refresh so the shell picks up the
        // profile that now exists.
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {error ? <Alert>{error}</Alert> : null}

      <div>
        <label htmlFor="username" className="mb-1.5 block text-sm font-medium">
          Choose a username
        </label>
        <Input
          id="username"
          name="username"
          required
          autoFocus
          minLength={3}
          maxLength={20}
          defaultValue={suggestion ?? ""}
          placeholder="quietalpha"
          autoComplete="off"
        />
        <p className="mt-1.5 text-xs text-muted">
          3–20 characters: letters, numbers and underscores. This is what other
          players see on the leaderboard.
        </p>
      </div>

      <Button type="submit" disabled={pending} className="w-full py-3.5 text-base">
        {pending ? "Setting up…" : "Start with $100,000"}
      </Button>
    </form>
  );
}
