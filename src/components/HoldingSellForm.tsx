"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { placeOrder } from "@/actions/trade";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { shares as fmtShares } from "@/lib/format";

/**
 * Inline sell/cover right on the Portfolio page, so closing a position
 * doesn't require a trip to Trade and re-searching the symbol. Only ever
 * sends `sell` or `cover` — the other two sides (buy/short) still need the
 * full picker on Trade, since they're opening a new position rather than
 * closing an existing row this form is attached to.
 *
 * Leverage is irrelevant to closing a position (execute_trade's sell/cover
 * branches never read it) but 1 is sent anyway for a clean, honest
 * trades.leverage value rather than inheriting DEFAULT_LEVERAGE's 2.
 */
export function HoldingSellForm({
  symbol,
  shares,
  isShort,
}: {
  symbol: string;
  shares: number;
  isShort: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(() => fmtShares(shares));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const label = isShort ? "Cover" : "Sell";

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        className="px-3 py-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
    );
  }

  function submit() {
    setError(null);
    const value = Number(amount);
    if (!amount || !Number.isFinite(value) || value <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }

    const formData = new FormData();
    formData.set("symbol", symbol);
    formData.set("side", isShort ? "cover" : "sell");
    formData.set("mode", "shares");
    formData.set("quantity", amount);
    formData.set("leverage", "1");

    startTransition(async () => {
      const res = await placeOrder(formData);
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center justify-end gap-1.5">
        <Input
          dense
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-20 text-right"
          aria-label={`${label} how many shares of ${symbol}`}
        />
        <Button
          type="button"
          variant={isShort ? "secondary" : "danger"}
          className="px-3 py-1.5 text-xs"
          disabled={pending}
          onClick={submit}
        >
          {pending ? "…" : label}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="px-2 py-1.5 text-xs"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      {error ? <div className="text-xs text-down">{error}</div> : null}
    </div>
  );
}
