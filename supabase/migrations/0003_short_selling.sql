-- Short selling.
--
-- A holdings row's `shares` becomes a signed net position: positive is long,
-- negative is short, and a row is deleted (never left at exactly zero) either
-- way. A symbol must be closed out in one direction before opening the other
-- — buy/sell only ever operate on a long-or-flat position, short/cover only
-- ever operate on a short-or-flat position — so there is no same-order
-- sign-crossing to reason about.
--
-- Shorting requires 1:1 cash collateral: opening or adding to a short is
-- checked against cash net of every other open short's liability in the
-- portfolio, computed live from `holdings` on every call rather than tracked
-- in a separate column. A persisted collateral column would drift from
-- reality across many trades (locking and releasing amounts round
-- independently) and would need explicit resetting on season reset; deriving
-- it live from `holdings` can never be stale.
--
-- Opening a short credits cash by the trade amount *and* raises liability by
-- the same amount, so v_available (cash minus liability, the figure buy is
-- checked against) is mathematically invariant under shorting — checking a
-- new short against it would only ever bound a single trade's size, never
-- the running total, letting unlimited small shorts through. The short
-- branch below subtracts liability a second time for exactly this reason:
-- it shrinks by the trade amount on every short, so total short liability
-- actually caps out at half of cash — the cash the account had before any
-- of it was shorted.

alter table holdings drop constraint shares_positive;
alter table holdings add constraint shares_nonzero check (shares <> 0);

create or replace function execute_trade(
  p_portfolio_id uuid,
  p_symbol       text,
  p_side         trade_side,
  p_shares       numeric,
  p_price        numeric
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor           uuid := auth.uid();
  v_cash            numeric(18,2);
  v_owner           uuid;
  v_amount          numeric(18,2);
  v_shares_now      numeric(18,6);
  v_avg_cost        numeric(18,4);
  v_short_liability numeric(18,2);
  v_available       numeric(18,2);
  v_trade_id        uuid;
begin
  if p_shares is null or p_shares <= 0 then
    raise exception 'Quantity must be greater than zero.' using errcode = '22023';
  end if;
  if p_price is null or p_price <= 0 then
    raise exception 'No usable price for %.', p_symbol using errcode = '22023';
  end if;

  -- FOR UPDATE serialises concurrent trades on this portfolio: a second request
  -- for the same portfolio blocks here until the first commits, so two orders
  -- cannot both pass the affordability check against the same cash.
  select cash, profile_id into v_cash, v_owner
    from portfolios
   where id = p_portfolio_id
     for update;

  if not found then
    raise exception 'Portfolio not found.' using errcode = '42501';
  end if;

  if not (
    (v_actor is not null and v_owner is not null and v_owner = v_actor)
    or is_admin()
    or coalesce(jwt_role(), '') = 'service_role'
  ) then
    raise exception 'That is not your portfolio.' using errcode = '42501';
  end if;

  v_amount := round(p_shares * p_price, 2);

  select shares, avg_cost into v_shares_now, v_avg_cost
    from holdings
   where portfolio_id = p_portfolio_id and symbol = p_symbol;

  -- Cash actually available to spend: total cash minus the liability of every
  -- open short in the portfolio (including this symbol's, if it is already
  -- short — that makes adding to an existing short correctly harder, not
  -- easier). Computed live so it can never drift out of sync with `holdings`.
  select coalesce(sum(-shares * avg_cost), 0) into v_short_liability
    from holdings
   where portfolio_id = p_portfolio_id and shares < 0;
  v_available := v_cash - v_short_liability;

  if p_side = 'buy' then
    if v_shares_now is not null and v_shares_now < 0 then
      raise exception 'You are short %. Cover it before buying it long.', p_symbol
        using errcode = '22023';
    end if;
    if v_amount > v_available then
      raise exception 'Not enough cash: order costs %, available %.',
        v_amount, v_available using errcode = '22023';
    end if;

    update portfolios set cash = cash - v_amount where id = p_portfolio_id;

    if v_shares_now is null then
      insert into holdings (portfolio_id, symbol, shares, avg_cost)
      values (p_portfolio_id, p_symbol, p_shares, p_price);
    else
      -- Weighted average cost, so P/L stays correct when adding to a position.
      update holdings
         set shares   = v_shares_now + p_shares,
             avg_cost = round(
               ((v_shares_now * v_avg_cost) + (p_shares * p_price))
               / (v_shares_now + p_shares), 4),
             updated_at = now()
       where portfolio_id = p_portfolio_id and symbol = p_symbol;
    end if;

  elsif p_side = 'sell' then
    if v_shares_now is not null and v_shares_now < 0 then
      raise exception 'You are short %. Use cover to close it, not sell.', p_symbol
        using errcode = '22023';
    end if;
    if v_shares_now is null or v_shares_now <= 0 then
      raise exception 'You do not own any %.', p_symbol using errcode = '22023';
    end if;
    if p_shares > v_shares_now then
      raise exception 'You only own % shares of %.', v_shares_now, p_symbol
        using errcode = '22023';
    end if;

    update portfolios set cash = cash + v_amount where id = p_portfolio_id;

    -- Selling out completely removes the row; avg_cost is deliberately left
    -- unchanged on a partial sale so remaining P/L still reflects what was paid.
    if v_shares_now - p_shares <= 0.0000005 then
      delete from holdings where portfolio_id = p_portfolio_id and symbol = p_symbol;
    else
      update holdings
         set shares = v_shares_now - p_shares, updated_at = now()
       where portfolio_id = p_portfolio_id and symbol = p_symbol;
    end if;

  elsif p_side = 'short' then
    if v_shares_now is not null and v_shares_now > 0 then
      raise exception 'You are long %. Sell it before shorting it.', p_symbol
        using errcode = '22023';
    end if;
    -- v_available - v_short_liability, not v_available alone — see the file
    -- header comment for why.
    if v_amount > (v_available - v_short_liability) then
      raise exception 'Not enough available cash to short: order needs %, available %.',
        v_amount, (v_available - v_short_liability) using errcode = '22023';
    end if;

    -- Sale proceeds are credited to cash exactly like a sell. Future buys are
    -- correctly blocked from spending it (v_available falls by v_amount for
    -- them), but a further short needs the extra subtraction above to be
    -- blocked too — see the file header.
    update portfolios set cash = cash + v_amount where id = p_portfolio_id;

    if v_shares_now is null then
      insert into holdings (portfolio_id, symbol, shares, avg_cost)
      values (p_portfolio_id, p_symbol, -p_shares, p_price);
    else
      -- Same weighted-average formula as buy, mirrored on the negative side:
      -- v_shares_now and -p_shares are both negative here, so the shape of
      -- the arithmetic is identical.
      update holdings
         set shares   = v_shares_now - p_shares,
             avg_cost = round(
               ((v_shares_now * v_avg_cost) + (-p_shares * p_price))
               / (v_shares_now - p_shares), 4),
             updated_at = now()
       where portfolio_id = p_portfolio_id and symbol = p_symbol;
    end if;

  else -- cover
    if v_shares_now is not null and v_shares_now > 0 then
      raise exception 'You are long %. Use sell to close it, not cover.', p_symbol
        using errcode = '22023';
    end if;
    if v_shares_now is null or v_shares_now >= 0 then
      raise exception 'You are not short %.', p_symbol using errcode = '22023';
    end if;
    if p_shares > -v_shares_now then
      raise exception 'You are only short % shares of %.', -v_shares_now, p_symbol
        using errcode = '22023';
    end if;
    -- Covering costs cash directly, like a buy, but does not need to be
    -- checked against v_available: closing a short only ever reduces total
    -- liability, so it can never create room for more leverage elsewhere.
    if v_amount > v_cash then
      raise exception 'Not enough cash to cover: order costs %, available %.',
        v_amount, v_cash using errcode = '22023';
    end if;

    update portfolios set cash = cash - v_amount where id = p_portfolio_id;

    -- avg_cost is left unchanged on a partial cover, mirroring sell.
    if -v_shares_now - p_shares <= 0.0000005 then
      delete from holdings where portfolio_id = p_portfolio_id and symbol = p_symbol;
    else
      update holdings
         set shares = v_shares_now + p_shares, updated_at = now()
       where portfolio_id = p_portfolio_id and symbol = p_symbol;
    end if;
  end if;

  insert into trades (portfolio_id, symbol, side, shares, price, amount)
  values (p_portfolio_id, p_symbol, p_side, p_shares, p_price, v_amount)
  returning id into v_trade_id;

  select cash into v_cash from portfolios where id = p_portfolio_id;

  return json_build_object(
    'trade_id', v_trade_id, 'symbol', p_symbol, 'side', p_side,
    'shares', p_shares, 'price', p_price, 'amount', v_amount, 'cash', v_cash
  );
end;
$$;
