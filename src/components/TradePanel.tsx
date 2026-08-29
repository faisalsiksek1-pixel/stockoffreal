"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { placeLimitOrder } from "@/actions/orders";
import { getInstrumentDetail, placeOrder } from "@/actions/trade";
import { PriceChart, type PricePoint } from "@/components/PriceChart";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { money, percent, shares as fmtShares, toneClass } from "@/lib/format";
import type { Instrument } from "@/lib/market/instruments";
import { shortLiability } from "@/lib/portfolio";
import { DEFAULT_LEVERAGE, LEVERAGE_OPTIONS, resolveOrder, type Leverage } from "@/lib/trade-rules";
import type { Holding, Quote, TradeSide } from "@/lib/types";

/**
 * Search, preview, submit.
 *
 * The preview uses the same resolveOrder rules the server runs, so a user sees
 * "not enough cash" before submitting rather than after. The server re-validates
 * and re-prices regardless — this is a convenience, never the enforcement.
 *
 * `buy` and `cover` both spend cash to reduce or open a long; `sell` and
 * `short` both credit cash to reduce or open a short. That split drives both
 * the button colour and the "cash after" math below.
 */

const SIDE_LABEL: Record<TradeSide, string> = {
  buy: "Buy",
  sell: "Sell",
  short: "Short",
  cover: "Cover",
};

function spendsCash(side: TradeSide): boolean {
  return side === "buy" || side === "cover";
}

interface Props {
  cash: number;
  availableCash: number;
  holdings: Holding[];
  instruments: Instrument[];
}

export function TradePanel({
  cash,
  availableCash,
  holdings,
  instruments,
}: Props) {
  const [query, setQuery] = useState("");
  // Known the instant a search result is clicked (it's local, static data);
  // the live quote + chart history load separately below, since that's the
  // one round trip this component makes.
  const [selected, setSelected] = useState<Instrument | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [side, setSide] = useState<TradeSide>("buy");
  const [mode, setMode] = useState<"dollars" | "shares">("dollars");
  const [amount, setAmount] = useState("");
  // Only buy/short spend leveraged buying power (see resolveOrder) — sell and
  // cover just ignore this.
  const [leverage, setLeverage] = useState<Leverage>(DEFAULT_LEVERAGE);
  // Limit orders only support buy/sell (see 0007_pending_orders.sql) — the
  // effect below drops back to "market" whenever short/cover is selected.
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [targetPrice, setTargetPrice] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const holdingBySymbol = useMemo(
    () => new Map(holdings.map((h) => [h.symbol, h])),
    [holdings],
  );

  const liability = useMemo(() => shortLiability(holdings), [holdings]);
  // Opening a short is checked against this, not availableCash directly —
  // see the comment on resolveOrder for why availableCash alone can't bound
  // shorting at all. resolveOrder applies the chosen leverage itself against
  // these raw (unleveraged) figures, so what it will actually allow is this
  // times leverage — buyingPower / shortBuyingPower below, used only for
  // display.
  const shortCapacity = availableCash - liability;
  const buyingPower = availableCash * leverage;
  const shortBuyingPower = shortCapacity * leverage;

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return instruments
      .filter((i) => i.symbol.includes(q) || i.name.toUpperCase().includes(q))
      .sort((a, b) => {
        const score = (i: Instrument) => (i.symbol === q ? 0 : i.symbol.startsWith(q) ? 1 : 2);
        return score(a) - score(b) || a.symbol.localeCompare(b.symbol);
      })
      .slice(0, 8);
  }, [query, instruments]);

  const held = selected ? holdingBySymbol.get(selected.symbol) : undefined;

  // The one live-data round trip in this component, deferred until a stock
  // is actually selected (see getInstrumentDetail's comment for why).
  // retryTick has no meaning beyond "changed" — bumping it re-runs the fetch
  // below without needing a new `selected` reference for the retry button.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!selected) {
      setQuote(null);
      setHistory([]);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuote(null);
    setHistory([]);
    setQuoteError(null);
    setLoadingQuote(true);
    getInstrumentDetail(selected.symbol).then((res) => {
      if (cancelled) return;
      setLoadingQuote(false);
      if (res.ok) {
        setQuote(res.quote);
        setHistory(res.history);
      } else {
        setQuoteError(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selected, retryTick]);

  // What the two toggle buttons show depends on the current position: flat
  // can open long or short, long can only add or close long, short can only
  // add or close short — a symbol must be flat before it can switch direction.
  const sideOptions = useMemo<[TradeSide, TradeSide]>(() => {
    if (!held) return ["buy", "short"];
    return held.shares > 0 ? ["buy", "sell"] : ["short", "cover"];
  }, [held]);

  useEffect(() => {
    if (!sideOptions.includes(side)) setSide(sideOptions[0]);
  }, [sideOptions, side]);

  useEffect(() => {
    if (orderType === "limit" && side !== "buy" && side !== "sell") setOrderType("market");
  }, [orderType, side]);

  const dayChange = useMemo(() => {
    if (!quote?.prevClose) return null;
    const amount = quote.price - quote.prevClose;
    return { amount, pct: amount / quote.prevClose };
  }, [quote]);

  const isLimit = orderType === "limit";
  const target = Number(targetPrice);
  const validTarget = targetPrice !== "" && Number.isFinite(target) && target > 0;
  // A limit order's real fill price is not known yet — it fills at whatever
  // the market is once the target is crossed, same as a real one. Previewing
  // against the target itself is a conservative stand-in: a buy can only
  // ever fill at or below it, a sell at or above it, so if this preview is
  // affordable now, the eventual fill only ever looks better, not worse
  // (unless cash moves between now and then).
  const previewPrice = isLimit ? target : quote?.price;

  const preview = useMemo(() => {
    if (!selected) return null;
    // Can't preview or submit without a real price — still loading, or the
    // quote fetch failed.
    if (!isLimit && !quote) return null;
    if (isLimit && !validTarget) return null;
    const value = Number(amount);
    if (!amount || !Number.isFinite(value) || value <= 0) return null;
    return resolveOrder(
      {
        symbol: selected.symbol,
        side,
        ...(mode === "shares" ? { shares: value } : { dollars: value }),
      },
      previewPrice!,
      cash,
      availableCash,
      liability,
      held,
      leverage,
    );
  }, [
    selected,
    quote,
    amount,
    side,
    mode,
    cash,
    availableCash,
    liability,
    held,
    isLimit,
    validTarget,
    previewPrice,
    leverage,
  ]);

  function submit() {
    if (!selected) return;
    setResult(null);

    if (isLimit) {
      const formData = new FormData();
      formData.set("symbol", selected.symbol);
      formData.set("side", side);
      formData.set("mode", mode);
      formData.set("quantity", amount);
      formData.set("targetPrice", targetPrice);
      formData.set("leverage", String(leverage));

      startTransition(async () => {
        const res = await placeLimitOrder(formData);
        if (res.ok) {
          setResult({ ok: true, text: res.message });
          setAmount("");
          setTargetPrice("");
          router.refresh();
        } else {
          setResult({ ok: false, text: res.error });
        }
      });
      return;
    }

    const formData = new FormData();
    formData.set("symbol", selected.symbol);
    formData.set("side", side);
    formData.set("mode", mode);
    formData.set("quantity", amount);
    formData.set("leverage", String(leverage));

    startTransition(async () => {
      const res = await placeOrder(formData);
      if (res.ok) {
        setResult({ ok: true, text: res.message });
        setAmount("");
        // Refresh so cash, holdings and rank reflect the fill immediately.
        router.refresh();
      } else {
        setResult({ ok: false, text: res.error });
      }
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="stock-search" className="mb-1.5 block text-sm font-medium">
          Search stocks
        </label>
        <Input
          id="stock-search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setResult(null);
          }}
          placeholder="Apple, NVDA, SPY…"
          autoComplete="off"
        />

        {query.trim() && matches.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            Nothing matches “{query.trim()}”. StockOff trades a curated list of{" "}
            {instruments.length} large stocks and ETFs.
          </p>
        ) : null}

        {matches.length > 0 ? (
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {matches.map((m) => (
              <li key={m.symbol}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(m);
                    setQuery("");
                    setResult(null);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{m.symbol}</div>
                    <div className="truncate text-xs text-muted">{m.name}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {selected ? (
        <div className="animate-rise space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xl font-semibold">{selected.symbol}</div>
              <div className="text-sm text-muted">{selected.name}</div>
            </div>
            <div className="text-right">
              {loadingQuote ? (
                <div className="text-sm text-muted">Loading price…</div>
              ) : quote ? (
                <div className="tnum text-xl font-semibold">{money(quote.price)}</div>
              ) : null}
              {dayChange ? (
                <div className={`tnum text-xs font-medium ${toneClass(dayChange.amount)}`}>
                  {dayChange.amount >= 0 ? "+" : ""}
                  {money(dayChange.amount)} ({percent(dayChange.pct)})
                </div>
              ) : null}
              {held ? (
                <div className="tnum text-xs text-muted">
                  {held.shares > 0
                    ? `You own ${fmtShares(held.shares)}`
                    : `You are short ${fmtShares(-held.shares)}`}
                </div>
              ) : null}
            </div>
          </div>

          {quoteError ? (
            <Alert kind="error">
              {quoteError}{" "}
              <button
                type="button"
                onClick={() => setRetryTick((n) => n + 1)}
                className="font-semibold underline"
              >
                Try again
              </button>
            </Alert>
          ) : null}

          <PriceChart history={history} />

          <div className="grid grid-cols-2 gap-2">
            {sideOptions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                aria-pressed={side === s}
                className={`rounded-xl border py-2.5 text-sm font-semibold uppercase tracking-wide transition ${
                  side === s
                    ? spendsCash(s)
                      ? "border-up bg-up/15 text-up"
                      : "border-down bg-down/15 text-down"
                    : "border-line text-muted hover:border-muted"
                }`}
              >
                {SIDE_LABEL[s]}
              </button>
            ))}
          </div>

          {side === "buy" || side === "short" ? (
            <div>
              <label className="mb-1.5 block text-sm font-medium">Leverage</label>
              <SegmentedControl
                options={LEVERAGE_OPTIONS.map((l) => ({ value: l, label: `${l}x` }))}
                value={leverage}
                onChange={(l) => {
                  setLeverage(l);
                  setResult(null);
                }}
              />
            </div>
          ) : null}

          {side === "buy" || side === "sell" ? (
            <SegmentedControl
              options={[
                { value: "market", label: "Market" },
                { value: "limit", label: "Limit (auto)" },
              ]}
              value={orderType}
              onChange={(t) => {
                setOrderType(t);
                setResult(null);
              }}
            />
          ) : null}

          {isLimit ? (
            <div>
              <label htmlFor="target-price" className="mb-1.5 block text-sm font-medium">
                Trigger price
              </label>
              <Input
                id="target-price"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={targetPrice}
                onChange={(e) => {
                  setTargetPrice(e.target.value);
                  setResult(null);
                }}
                placeholder={quote ? quote.price.toFixed(2) : "0.00"}
              />
              <p className="mt-1.5 text-xs text-muted">
                {side === "buy"
                  ? `Fills automatically the next time you're on StockOff after ${selected.symbol} drops to $${validTarget ? target.toFixed(2) : "…"} or lower.`
                  : `Fills automatically the next time you're on StockOff after ${selected.symbol} rises to $${validTarget ? target.toFixed(2) : "…"} or higher.`}
              </p>
            </div>
          ) : null}

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label htmlFor="quantity" className="text-sm font-medium">
                Amount
              </label>
              <SegmentedControl
                fullWidth={false}
                options={[
                  { value: "dollars", label: "$" },
                  { value: "shares", label: "Shares" },
                ]}
                value={mode}
                onChange={setMode}
              />
            </div>
            <Input
              id="quantity"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setResult(null);
              }}
              placeholder={mode === "dollars" ? "1000" : "10"}
            />

            {side === "buy" || side === "short" ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[25, 50, 100].map((pct) => {
                  const limit = side === "buy" ? buyingPower : shortBuyingPower;
                  return (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        setMode("dollars");
                        // Floor to cents so a 100% button never asks for a
                        // fraction of a cent more than the limit allows.
                        setAmount((Math.floor(limit * (pct / 100) * 100) / 100).toString());
                      }}
                      className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted transition hover:border-muted hover:text-fg"
                    >
                      {pct === 100 ? "Max" : `${pct}%`}
                    </button>
                  );
                })}
                <span className="tnum ml-auto self-center text-xs text-muted">
                  {money(side === "buy" ? buyingPower : shortBuyingPower)} available ({leverage}x)
                </span>
              </div>
            ) : held ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setMode("shares");
                    setAmount(String(Math.abs(held.shares)));
                  }}
                  className="rounded-lg border border-line px-2.5 py-1 text-xs font-medium text-muted transition hover:border-muted hover:text-fg"
                >
                  {side === "cover" ? "Cover all" : "Sell all"}
                </button>
              </div>
            ) : null}
          </div>

          {preview && !preview.ok ? <Alert>{preview.error}</Alert> : null}

          {preview?.ok ? (
            <dl className="space-y-1.5 rounded-xl border border-line bg-surface-2 p-3.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Shares</dt>
                <dd className="tnum font-medium">{fmtShares(preview.shares)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">{isLimit ? "Trigger price" : "Price"}</dt>
                <dd className="tnum font-medium">{money(previewPrice!)}</dd>
              </div>
              <div className="flex justify-between border-t border-line pt-1.5">
                <dt className="font-medium">
                  {isLimit ? "Estimated " : ""}
                  {spendsCash(side) ? "total cost" : "proceeds"}
                </dt>
                <dd className="tnum font-bold">{money(preview.amount)}</dd>
              </div>
              {!isLimit ? (
                <div className="flex justify-between">
                  <dt className="text-muted">Cash after</dt>
                  <dd className="tnum text-muted">
                    {money(spendsCash(side) ? cash - preview.amount : cash + preview.amount)}
                  </dd>
                </div>
              ) : null}
              {side === "short" ? (
                <div className="flex justify-between">
                  <dt className="text-muted">Collateral locked</dt>
                  <dd className="tnum text-muted">{money(preview.amount)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          <Button
            type="button"
            onClick={submit}
            disabled={pending || !preview?.ok}
            className="w-full py-3.5 text-base"
          >
            {pending
              ? "Placing…"
              : preview?.ok
                ? isLimit
                  ? `Place ${SIDE_LABEL[side].toLowerCase()} order`
                  : `${SIDE_LABEL[side]} ${selected.symbol}`
                : isLimit && !validTarget
                  ? "Enter a trigger price"
                  : !isLimit && loadingQuote
                    ? "Loading price…"
                    : !isLimit && quoteError
                      ? "Price unavailable"
                      : "Enter an amount"}
          </Button>

          {result ? (
            <Alert kind={result.ok ? "success" : "error"}>{result.text}</Alert>
          ) : null}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-line px-5 py-8 text-center text-sm text-muted">
          Search for a stock above to place your first order.
        </p>
      )}
    </div>
  );
}
