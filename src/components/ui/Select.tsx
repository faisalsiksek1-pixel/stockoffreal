import type { ComponentProps } from "react";

/** Same shape and variants as Input, for the app's handful of <select>s. */
export function Select({
  dense = false,
  className = "",
  ...props
}: ComponentProps<"select"> & { dense?: boolean }) {
  return (
    <select
      {...props}
      className={`w-full rounded-xl border border-line bg-surface-2 outline-none transition focus:border-ai ${
        dense ? "px-3 py-2.5 text-sm" : "px-4 py-3 text-base"
      } ${className}`}
    />
  );
}
