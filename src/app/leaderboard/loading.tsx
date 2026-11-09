// This page sits outside the (app) layout group (it's public, no account
// needed), so it renders its own header rather than inheriting one — this
// skeleton echoes that header's shape too, or navigating here would show a
// blank top of the page for the ~1-2s this covers.
export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 pb-16 pt-8">
      <div className="h-7 w-32 animate-pulse rounded-xl bg-surface" />
      <div className="h-10 animate-pulse rounded-2xl bg-surface" />
      <div className="h-64 animate-pulse rounded-2xl bg-surface" />
    </div>
  );
}
