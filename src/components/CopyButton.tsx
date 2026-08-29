"use client";

import { useState } from "react";

/**
 * Copy to clipboard with a visible confirmation. Falls back to selecting the
 * text when the Clipboard API is unavailable (older mobile browsers, non-HTTPS).
 */
export function CopyButton({
  value,
  label = "Copy link",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this:", value);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`rounded-xl border border-line px-4 py-2.5 text-sm font-semibold transition hover:border-muted ${className}`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
