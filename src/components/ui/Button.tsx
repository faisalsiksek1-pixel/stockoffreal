import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const STYLES: Record<Variant, string> = {
  primary: "bg-ai text-on-accent hover:opacity-90",
  secondary: "bg-surface-2 text-fg border border-line hover:border-muted",
  ghost: "text-muted hover:text-fg",
  danger: "bg-down text-on-accent hover:opacity-90",
};

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: Variant; children: ReactNode }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${STYLES[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
