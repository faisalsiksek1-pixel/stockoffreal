-- Selectable leverage.
--
-- 0006 gave every `buy` and `short` a fixed, global 2x multiplier. This lets
-- the trader choose it per order instead — 1x (none), 2x, 5x, 10x or 20x —
-- same set as LEVERAGE_OPTIONS in src/lib/trade-rules.ts, which is the other
-- half of this check: change both together.
--
-- Still no interest and no margin call. A leveraged buy or short just spends
-- real cash it does not have, so cash can go negative (margin debt) exactly
-- like before; only the multiplier is now a choice instead of a constant.
--
-- `p_leverage` is appended with a default of 2 (the old fixed value) rather
-- than inserted earlier in the argument list, so every existing caller —
-- including the schema tests, which call execute_trade and
-- place_limit_order with their original argument counts — keeps working
-- unchanged and keeps getting the old behaviour.
--
-- The chosen leverage is stored alongside each trade (and each pending
-- order, until it fills) purely as a record of what was actually applied —
-- nothing reads it back to gate anything, the same way `price` and `amount`
-- are kept for the log but never re-validated from it.

alter table trades add column leverage numeric(4,1) not null default 1
  check (leverage in (1, 2, 5, 10, 20));

alter table pending_orders add column leverage numeric(4,1) not null default 2
  check (leverage in (1, 2, 5, 10, 20));

-- Must be dropped first: adding a parameter changes the signature, so
-- `create or replace` would leave the old 5-argument version behind as a
-- second, ambiguous overload rather than replacing it.
drop function if exists execute_trade(uuid, text, trade_side, numeric, numeric);

create or replace function execute_trade(
  p_portfolio_id uuid,
  p_symbol       text,
  p_side         trade_side,
  p_shares       numeric,
  p_price        numeric,
  p_leverage     numeric default 2
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
  v_leverage        numeric;
  v_trade_id        uuid;
begin
  if p_shares is null or p_shares <= 0 then
    raise exception 'Quantity must be greater than zero.' using errcode = '22023';
  end if;
  if p_price is null or p_price <= 0 then
    raise exception 'No usable price for %.', p_symbol using errcode = '22023';
  end if;
  if p_leverage is null or p_leverage not in (1, 2, 5, 10, 20) then
    raise exception 'Invalid leverage: %.', p_leverage using errcode = '22023';
  end if;
  v_leverage := p_leverage;

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
    if v_amount > v_available * v_leverage then
      raise exception 'Not enough buying power: order costs %, available % at %x leverage.',
        v_amount, v_available * v_leverage, v_leverage using errcode = '22023';
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
    -- v_available - v_short_liability, not v_available alone — see 0003's
    -- header comment for why — then leveraged same as buy.
    if v_amount > (v_available - v_short_liability) * v_leverage then
      raise exception 'Not enough buying power to short: order needs %, available % at %x leverage.',
        v_amount, (v_available - v_short_liability) * v_leverage, v_leverage
        using errcode = '22023';
    end if;

    -- Sale proceeds are credited to cash exactly like a sell. Future buys are
    -- correctly blocked from spending it (v_available falls by v_amount for
    -- them), but a further short needs the extra subtraction above to be
    -- blocked too — see 0003's header comment.
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
    -- checked against v_available (leveraged or not): closing a short only
    -- ever reduces total liability, so it can never create room for more
    -- leverage elsewhere.
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

  -- Recorded for every side, not just buy/short: sell and cover always pass
  -- through at v_leverage's default of 1, which is honest — leverage plays
  -- no part in closing a position.
  insert into trades (portfolio_id, symbol, side, shares, price, amount, leverage)
  values (p_portfolio_id, p_symbol, p_side, p_shares, p_price, v_amount, v_leverage)
  returning id into v_trade_id;

  select cash into v_cash from portfolios where id = p_portfolio_id;

  return json_build_object(
    'trade_id', v_trade_id, 'symbol', p_symbol, 'side', p_side,
    'shares', p_shares, 'price', p_price, 'amount', v_amount, 'cash', v_cash,
    'leverage', v_leverage
  );
end;
$$;

drop function if exists place_limit_order(uuid, text, trade_side, text, numeric, numeric);

create or replace function place_limit_order(
  p_portfolio_id uuid,
  p_symbol       text,
  p_side         trade_side,
  p_mode         text,
  p_quantity     numeric,
  p_target_price numeric,
  p_leverage     numeric default 2
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_owner    uuid;
  v_shares   numeric(18,6);
  v_order_id uuid;
begin
  if p_side not in ('buy', 'sell') then
    raise exception 'Limit orders support buy or sell only.' using errcode = '22023';
  end if;
  if p_mode not in ('shares', 'dollars') then
    raise exception 'Invalid order mode.' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Enter a quantity greater than zero.' using errcode = '22023';
  end if;
  if p_target_price is null or p_target_price <= 0 then
    raise exception 'Enter a target price greater than zero.' using errcode = '22023';
  end if;
  if p_leverage is null or p_leverage not in (1, 2, 5, 10, 20) then
    raise exception 'Invalid leverage: %.', p_leverage using errcode = '22023';
  end if;

  select profile_id into v_owner from portfolios where id = p_portfolio_id;
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

  -- A sell order can only ever be for shares already held — otherwise it can
  -- never fill and is just clutter. Checked only in 'shares' mode: a
  -- 'dollars' sell's eventual share count depends on the price it fills at,
  -- which is not known yet, so it is left to fail quietly at fill time
  -- instead (same as a buy that outruns its owner's cash).
  if p_side = 'sell' and p_mode = 'shares' then
    select shares into v_shares
      from holdings
     where portfolio_id = p_portfolio_id and symbol = p_symbol;
    if v_shares is null or v_shares < p_quantity then
      raise exception 'You only own % share(s) of %.', coalesce(v_shares, 0), p_symbol
        using errcode = '22023';
    end if;
  end if;

  insert into pending_orders (portfolio_id, symbol, side, mode, quantity, target_price, leverage)
  values (p_portfolio_id, p_symbol, p_side, p_mode, p_quantity, p_target_price, p_leverage)
  returning id into v_order_id;

  return v_order_id;
end;
$$;

-- Fills now carry the leverage chosen at placement time through to
-- execute_trade, instead of relying on its default — a buy limit order
-- placed at 5x must still fill at 5x, not silently fall back to 2x.
create or replace function fill_pending_order(
  p_order_id uuid,
  p_price    numeric,
  p_shares   numeric
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_owner        uuid;
  v_portfolio_id uuid;
  v_symbol       text;
  v_side         trade_side;
  v_target       numeric(18,4);
  v_leverage     numeric(4,1);
  v_result       json;
begin
  select o.portfolio_id, o.symbol, o.side, o.target_price, o.leverage, p.profile_id
    into v_portfolio_id, v_symbol, v_side, v_target, v_leverage, v_owner
    from pending_orders o
    join portfolios p on p.id = o.portfolio_id
   where o.id = p_order_id
     for update of o;

  if not found then
    raise exception 'Order not found.' using errcode = '42501';
  end if;

  if not (
    (v_actor is not null and v_owner is not null and v_owner = v_actor)
    or is_admin()
    or coalesce(jwt_role(), '') = 'service_role'
  ) then
    raise exception 'That is not your order.' using errcode = '42501';
  end if;

  if v_side = 'buy' and p_price > v_target then
    raise exception 'Order not due: price % is above the buy target %.', p_price, v_target
      using errcode = '22023';
  end if;
  if v_side = 'sell' and p_price < v_target then
    raise exception 'Order not due: price % is below the sell target %.', p_price, v_target
      using errcode = '22023';
  end if;

  select execute_trade(v_portfolio_id, v_symbol, v_side, p_shares, p_price, v_leverage) into v_result;

  delete from pending_orders where id = p_order_id;

  return v_result;
end;
$$;
