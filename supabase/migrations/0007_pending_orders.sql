-- Limit orders ("auto buy" / "auto sell").
--
-- A pending order sits here until its price target is crossed, then it fills
-- and the row is deleted — same "never left around once resolved" shape as
-- holdings closing out at zero. There is no `status` column and no history
-- kept in this table: a filled order's permanent record is the `trades` row
-- execute_trade already writes, so keeping a second copy here would just be
-- two sources of truth that could disagree.
--
-- Scoped to buy/sell only, not short/cover — mirrors what the product asked
-- for. Nothing below stops that being extended later.
--
-- There is no cron or scheduled job anywhere in this app (see mock.ts: prices
-- are deterministic per UTC day, computed on request, not ticked). So orders
-- are not filled by a background process — they are checked lazily, against
-- whatever the market's current quotes are, every time the signed-in owner
-- loads a page that shows their portfolio (see src/lib/orders.ts). That means
-- a crossed order can sit filled-but-undetected until its owner's next page
-- view; nothing else in this app updates in the background either.
--
-- Same write model as everywhere else in this schema: users get a select
-- policy and nothing else. Every mutation — placing, cancelling, filling —
-- goes through a SECURITY DEFINER function that checks ownership itself,
-- exactly like execute_trade. See 0001's note on why: RLS cannot restrict an
-- UPDATE/DELETE to "only while it's still mine and still pending" as
-- precisely as a function body can, and a blanket write policy would open
-- the door to fabricating or force-filling an order from the browser.

create table pending_orders (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  symbol       text not null,
  side         trade_side not null,
  mode         text not null,
  quantity     numeric(18,6) not null check (quantity > 0),
  target_price numeric(18,4) not null check (target_price > 0),
  created_at   timestamptz not null default now(),

  constraint pending_orders_side_buy_or_sell check (side in ('buy', 'sell')),
  constraint pending_orders_mode_valid check (mode in ('shares', 'dollars'))
);

create index pending_orders_portfolio_idx on pending_orders (portfolio_id);

alter table pending_orders enable row level security;

-- Public, like every other portfolio-shaped table here (see 0001: holdings
-- and trades are both `using (true)`) — a pending order is no more sensitive
-- than the position or trade log it would turn into.
create policy "orders readable" on pending_orders for select using (true);

-- Place a limit order. Ownership check mirrors execute_trade's exactly: an
-- actor must own the portfolio, or be an admin, or be the service role.
create or replace function place_limit_order(
  p_portfolio_id uuid,
  p_symbol       text,
  p_side         trade_side,
  p_mode         text,
  p_quantity     numeric,
  p_target_price numeric
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

  insert into pending_orders (portfolio_id, symbol, side, mode, quantity, target_price)
  values (p_portfolio_id, p_symbol, p_side, p_mode, p_quantity, p_target_price)
  returning id into v_order_id;

  return v_order_id;
end;
$$;

-- Cancel a still-pending order. Same ownership check, reached through the
-- order's portfolio rather than a direct column on it.
create or replace function cancel_limit_order(p_order_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_owner uuid;
begin
  select p.profile_id into v_owner
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

  delete from pending_orders where id = p_order_id;
end;
$$;

-- Fill a due order. Called from the server only (src/lib/orders.ts), never
-- directly from the browser — p_price and p_shares are trusted the same way
-- execute_trade already trusts its own p_price, for the same reason: this is
-- server-computed, not client-supplied. Re-validating the crossing here is
-- about correctness (an order fired at a stale or wrong price is a real bug
-- worth catching loudly) rather than a security boundary.
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
  v_result       json;
begin
  select o.portfolio_id, o.symbol, o.side, o.target_price, p.profile_id
    into v_portfolio_id, v_symbol, v_side, v_target, v_owner
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

  select execute_trade(v_portfolio_id, v_symbol, v_side, p_shares, p_price) into v_result;

  delete from pending_orders where id = p_order_id;

  return v_result;
end;
$$;
