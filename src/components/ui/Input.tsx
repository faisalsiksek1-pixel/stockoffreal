import type { ComponentProps } from "react";

/** The one text-input style, shared by every form in the app. `dense` is the
 *  smaller variant admin's forms need. */
export function Input({
  dense = false,
  className = "",
  ...props
}: ComponentProps<"input"> & { dense?: boolean }) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-line bg-surface-2 outline-none transition placeholder:text-muted focus:border-ai ${
        dense ? "px-3 py-2.5 text-sm" : "px-4 py-3 text-base"
      } ${className}`}
    />
  );
}
