export function Alert({
  kind = "error",
  children,
}: {
  kind?: "error" | "success";
  children: React.ReactNode;
}) {
  const tone =
    kind === "error"
      ? "border-down/40 bg-down/10 text-down"
      : "border-up/40 bg-up/10 text-up";
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 text-sm ${tone}`}
    >
      {children}
    </div>
  );
}
