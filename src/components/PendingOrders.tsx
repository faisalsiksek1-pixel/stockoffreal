"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelPendingOrder } from "@/actions/orders";
import { Alert } from "@/components/ui/Alert";
import { money, shares as fmtShares } from "@/lib/format";
import type { PendingOrder } from "@/lib/types";

/**
 * Open limit orders for the current portfolio. A row disappears from here the
 * moment it fills or is cancelled — see 0007_pending_orders.sql for why there
 * is no "history" of past pending orders to show alongside it.
 */
export function PendingOrders({ orders }: { orders: PendingOrder[] }) {
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (orders.length === 0) return null;

  function cancel(id: string) {
    setError(null);
    setCancellingId(id);
    startTransition(async () => {
      const res = await cancelPendingOrder(id);
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-muted">Pending orders</h2>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {orders.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <div className="text-sm font-semibold">
                {o.side === "buy" ? "Buy" : "Sell"} {o.symbol}
              </div>
              <div className="tnum text-xs text-muted">
                {o.mode === "shares" ? `${fmtShares(o.quantity)} shares` : money(o.quantity)}{" "}
                {o.side === "buy" ? "at or below" : "at or above"} {money(o.targetPrice)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => cancel(o.id)}
              disabled={pending && cancellingId === o.id}
              className="rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:border-down hover:text-down"
            >
              {pending && cancellingId === o.id ? "Cancelling…" : "Cancel"}
            </button>
          </li>
        ))}
      </ul>
      {error ? <Alert kind="error">{error}</Alert> : null}
    </div>
  );
}
