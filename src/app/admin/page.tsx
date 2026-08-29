import Link from "next/link";
import { redirect } from "next/navigation";

import { RenameUserPanel, SeasonPanel, SpecialTradePanel } from "@/components/AdminPanels";
import { Wordmark } from "@/components/Wordmark";
import { Badge } from "@/components/ui/Badge";
import { Card, CardTitle } from "@/components/ui/Card";
import { PageHeading } from "@/components/ui/PageHeading";
import { money, shares as fmtShares } from "@/lib/format";
import { getMyProfile } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Admin - StockOff" };
export const dynamic = "force-dynamic";

/**
 * Admin dashboard.
 *
 * Guarded twice: middleware requires a session, and this page requires
 * is_admin. Every mutation re-checks server-side in the action itself, so a
 * crafted POST cannot bypass the UI.
 */
export default async function AdminPage() {
  const profile = await getMyProfile();
  if (!profile) redirect("/login");
  if (!profile.is_admin) redirect("/dashboard");

  const supabase = await createClient();

  const [{ data: users }, { data: trades }, { data: season }, { data: specials }] =
    await Promise.all([
      supabase.from("profiles").select("id, username, created_at").order("created_at", { ascending: false }).limit(50),
      supabase.from("trades").select("id, symbol, side, shares, price, amount, created_at, portfolio_id").order("created_at", { ascending: false }).limit(25),
      supabase.from("seasons").select("name, slug, starts_at").eq("is_active", true).maybeSingle(),
      supabase.from("portfolios").select("owner_type, display_name, cash, strategy_note").in("owner_type", ["human", "ai", "benchmark"]),
    ]);

  return (
    <div className="mx-auto max-w-5xl px-5 pb-16 pt-8">
      <header className="mb-8 flex items-center justify-between">
        <Link href="/dashboard">
          <Wordmark className="text-lg" />
        </Link>
        <Badge tone="ai">Admin</Badge>
      </header>

      <PageHeading>Admin</PageHeading>
      <p className="mt-1 text-sm text-muted">
        Active season: {season?.name ?? "none"}
      </p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <SpecialTradePanel />
        <SeasonPanel />
        <RenameUserPanel users={(users ?? []).map((u) => ({ id: u.id as string, username: u.username as string }))} />

        <Card>
          <CardTitle>Special portfolios</CardTitle>
          <ul className="space-y-2 text-sm">
            {(specials ?? []).map((s) => (
              <li key={s.owner_type as string} className="border-b border-line pb-2 last:border-0">
                <div className="flex justify-between">
                  <span className="font-semibold capitalize">{s.owner_type as string}</span>
                  <span className="tnum text-muted">{money(Number(s.cash))} cash</span>
                </div>
                <div className="text-xs text-muted">{s.display_name as string}</div>
                {s.strategy_note ? (
                  <p className="mt-1 text-xs text-muted">{s.strategy_note as string}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Players ({users?.length ?? 0})</CardTitle>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {(users ?? []).map((u) => (
              <li key={u.id as string} className="flex justify-between border-b border-line py-1.5 last:border-0">
                <span>{u.username as string}</span>
                <span className="text-xs text-muted">
                  {new Date(u.created_at as string).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardTitle>Recent trades</CardTitle>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {(trades ?? []).map((t) => (
              <li key={t.id as string} className="flex items-center gap-2 border-b border-line py-1.5 last:border-0">
                <Badge tone={t.side === "buy" ? "up" : "down"}>{t.side as string}</Badge>
                <span className="font-medium">{t.symbol as string}</span>
                <span className="tnum text-xs text-muted">
                  {fmtShares(Number(t.shares))} @ {money(Number(t.price))}
                </span>
                <span className="tnum ml-auto text-xs">{money(Number(t.amount))}</span>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
