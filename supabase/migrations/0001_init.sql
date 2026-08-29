-- StockOff schema.
--
-- Central design decision: users, the AI, the Human and the S&P 500 benchmark
-- are all rows in `portfolios`, distinguished by `owner_type`. The leaderboard
-- is then one query over one table instead of a union of four shapes, and every
-- competitor is valued by exactly the same code path — which is the only way the
-- comparison is honest.

-- No extensions required: gen_random_uuid() has been in core Postgres since 13,
-- so pgcrypto is unnecessary here and requiring it would only cost portability.

-- ---------------------------------------------------------------------------
-- Seasons
-- ---------------------------------------------------------------------------
create table seasons (
  id               uuid primary key default gen_random_uuid(),
  name             text        not null,
  slug             text        not null unique,
  starting_balance numeric(18,2) not null default 100000,
  starts_at        timestamptz not null default now(),
  ends_at          timestamptz,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text        not null unique,
  is_admin   boolean     not null default false,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[A-Za-z0-9_]{3,20}$')
);

-- ---------------------------------------------------------------------------
-- Portfolios
-- ---------------------------------------------------------------------------
create type portfolio_owner as enum ('user', 'ai', 'human', 'benchmark');

create table portfolios (
  id               uuid primary key default gen_random_uuid(),
  season_id        uuid not null references seasons(id) on delete cascade,
  owner_type       portfolio_owner not null,
  profile_id       uuid references profiles(id) on delete cascade,
  display_name     text not null,
  cash             numeric(18,2) not null,
  starting_balance numeric(18,2) not null,
  strategy_note    text,
  created_at       timestamptz not null default now(),

  -- A user portfolio must have an owner; the special competitors must not.
  constraint owner_matches_type check (
    (owner_type = 'user' and profile_id is not null)
    or (owner_type <> 'user' and profile_id is null)
  ),
  -- One portfolio per user per season, and one of each special competitor.
  constraint one_user_portfolio_per_season unique (season_id, profile_id)
);

-- Exactly one AI / Human / benchmark portfolio per season.
create unique index one_special_per_season
  on portfolios (season_id, owner_type)
  where owner_type <> 'user';

create index portfolios_season_idx on portfolios (season_id);

-- ---------------------------------------------------------------------------
-- Holdings
-- ---------------------------------------------------------------------------
create table holdings (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  symbol       text not null,
  shares       numeric(18,6) not null,
  avg_cost     numeric(18,4) not null,
  updated_at   timestamptz not null default now(),

  constraint shares_positive check (shares > 0),
  constraint one_row_per_symbol unique (portfolio_id, symbol)
);

create index holdings_portfolio_idx on holdings (portfolio_id);

-- ---------------------------------------------------------------------------
-- Trades (append-only audit log)
-- ---------------------------------------------------------------------------
create type trade_side as enum ('buy', 'sell');

create table trades (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  symbol       text not null,
  side         trade_side not null,
  shares       numeric(18,6) not null check (shares > 0),
  price        numeric(18,4) not null check (price > 0),
  amount       numeric(18,2) not null,
  note         text,
  created_at   timestamptz not null default now()
);

create index trades_portfolio_idx on trades (portfolio_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Leagues
-- ---------------------------------------------------------------------------
create table leagues (
  id         uuid primary key default gen_random_uuid(),
  season_id  uuid not null references seasons(id) on delete cascade,
  name       text not null,
  code       text not null unique,
  is_public  boolean not null default false,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table league_members (
  league_id    uuid not null references leagues(id) on delete cascade,
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  primary key (league_id, portfolio_id)
);

-- ---------------------------------------------------------------------------
-- Price cache
-- ---------------------------------------------------------------------------
-- Written server-side only. Doubles as the searchable instrument list, so stock
-- search works with zero external API calls.
create table price_cache (
  symbol     text primary key,
  name       text not null,
  price      numeric(18,4) not null,
  prev_close numeric(18,4) not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Defined before the functions that call them so the file reads top-to-bottom.

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

-- The role from the request JWT. Deliberately not `current_user`: inside a
-- SECURITY DEFINER function current_user reports the function's owner, so it
-- cannot distinguish a service-role call from a signed-in user's call. The JWT
-- claim is unaffected by definer rights.
create or replace function jwt_role() returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
$$;

-- ---------------------------------------------------------------------------
-- Trade execution
-- ---------------------------------------------------------------------------
-- All order execution goes through this function. It exists so that the balance
-- check and the balance mutation happen inside one transaction holding a row
-- lock on the portfolio — two trade requests arriving together cannot both pass
-- an affordability check against the same cash and overspend it.
--
-- `p_price` is supplied by the server, never the client: the caller looks the
-- price up server-side before invoking this.
--
-- SECURITY DEFINER is required, not incidental: users deliberately hold no write
-- policy on `holdings` or `trades`, so an invoker-rights function would be denied
-- by RLS on its own inserts. Definer rights bypass RLS, which means the ownership
-- check RLS would have performed is performed explicitly below instead.
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
  v_actor      uuid := auth.uid();
  v_cash       numeric(18,2);
  v_owner      uuid;
  v_amount     numeric(18,2);
  v_shares_now numeric(18,6);
  v_avg_cost   numeric(18,4);
  v_trade_id   uuid;
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

  -- Authorisation. Definer rights mean RLS is not guarding this, so it is guarded
  -- here: you may trade your own portfolio, and nothing else. The AI, Human and
  -- benchmark portfolios have a null owner and so are reachable only by an admin
  -- or by server-side seeding.
  --
  -- Every operand below is deliberately forced to a non-null boolean. A plain
  -- `v_owner = v_actor` evaluates to NULL whenever either side is null — an
  -- unauthenticated caller, or one of the null-owner special portfolios — and
  -- `if not NULL then` does not fire, so the guard would wave through exactly the
  -- two cases it exists to stop.
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

  if p_side = 'buy' then
    if v_amount > v_cash then
      raise exception 'Not enough cash: order costs %, available %.',
        v_amount, v_cash using errcode = '22023';
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

  else -- sell
    if v_shares_now is null then
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

-- ---------------------------------------------------------------------------
-- Signup bootstrap
-- ---------------------------------------------------------------------------
-- Runs as the definer so a brand-new user gets a profile, a funded portfolio and
-- public-league membership in one transaction. Doing this client-side would
-- leave half-created accounts behind whenever a request failed midway.
create or replace function bootstrap_new_user(
  p_username text,
  p_is_admin boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_season       seasons;
  v_portfolio_id uuid;
  v_league_id    uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select * into v_season from seasons where is_active order by starts_at desc limit 1;
  if not found then
    raise exception 'No active season.' using errcode = '22023';
  end if;

  insert into profiles (id, username, is_admin)
  values (v_uid, p_username, p_is_admin);

  insert into portfolios (season_id, owner_type, profile_id, display_name,
                          cash, starting_balance)
  values (v_season.id, 'user', v_uid, p_username,
          v_season.starting_balance, v_season.starting_balance)
  returning id into v_portfolio_id;

  select id into v_league_id
    from leagues
   where season_id = v_season.id and is_public
   order by created_at limit 1;

  if v_league_id is not null then
    insert into league_members (league_id, portfolio_id)
    values (v_league_id, v_portfolio_id);
  end if;

  return v_portfolio_id;
end;
$$;

-- Join a private league by code. Definer-rights because the joiner cannot read
-- the leagues table by code before they are a member.
create or replace function join_league_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_league       leagues;
  v_portfolio_id uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select * into v_league from leagues where upper(code) = upper(p_code);
  if not found then
    raise exception 'No league with that code.' using errcode = '22023';
  end if;

  select id into v_portfolio_id
    from portfolios
   where profile_id = v_uid and season_id = v_league.season_id;

  if v_portfolio_id is null then
    raise exception 'You have no portfolio in that season.' using errcode = '22023';
  end if;

  insert into league_members (league_id, portfolio_id)
  values (v_league.id, v_portfolio_id)
  on conflict do nothing;

  return v_league.id;
end;
$$;

-- Shows someone holding an invite code what they are about to join, without
-- granting them read access to the leagues table. Returns the name and size only
-- — never the code, which the caller already has if they got here legitimately.
create or replace function league_preview(p_code text)
returns table (id uuid, name text, member_count bigint)
language sql stable security definer set search_path = public
as $$
  select l.id,
         l.name,
         (select count(*) from league_members m where m.league_id = l.id)
    from leagues l
   where upper(l.code) = upper(p_code);
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table seasons        enable row level security;
alter table profiles       enable row level security;
alter table portfolios     enable row level security;
alter table holdings       enable row level security;
alter table trades         enable row level security;
alter table leagues        enable row level security;
alter table league_members enable row level security;
alter table price_cache    enable row level security;

-- Leaderboards are public by design: anyone can read usernames, portfolio
-- values and holdings. Nothing here is sensitive — emails and auth data live in
-- auth.users, which is never exposed. Writes are locked to the owner.
create policy "seasons readable"      on seasons        for select using (true);
create policy "profiles readable"     on profiles       for select using (true);
create policy "portfolios readable"   on portfolios     for select using (true);
create policy "holdings readable"     on holdings       for select using (true);
create policy "trades readable"       on trades         for select using (true);
create policy "members readable"      on league_members for select using (true);
create policy "prices readable"       on price_cache    for select using (true);

-- Public leagues are readable by anyone. A private league is readable only by its
-- creator and its members, because the row contains the invite code: a blanket
-- `using (true)` would hand every private code to any caller holding the public
-- anon key, which would make the codes decorative. Non-members preview a league
-- through league_preview() instead.
--
-- The `created_by` arm is not a convenience. Without it a creator cannot see the
-- league they just made until they are a member — but joining requires reading the
-- row first, and `insert ... returning` needs select visibility too, so creating a
-- private league would fail outright.
create policy "leagues readable" on leagues for select using (
  is_public
  or created_by = auth.uid()
  or exists (
    select 1
      from league_members m
      join portfolios p on p.id = m.portfolio_id
     where m.league_id = leagues.id
       and p.profile_id = auth.uid()
  )
);

create policy "own profile update" on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- Note what is absent: users have no insert, update or delete policy on
-- portfolios, holdings or trades. That is the whole point. RLS cannot restrict an
-- UPDATE to a single column, so any policy permitting a user to update their own
-- portfolio row would also permit `set cash = 99999999` straight from the browser
-- with the public anon key. Cash moves only inside execute_trade.

create policy "create own league" on leagues for insert
  with check (created_by = auth.uid());

-- Lets a user put their own portfolio into a league — needed so the creator of a
-- league ends up in it. Scoped to portfolios they own, so nobody can add or
-- remove another player.
create policy "join with own portfolio" on league_members for insert
  with check (portfolio_id in (select id from portfolios where profile_id = auth.uid()));

create policy "leave own league" on league_members for delete
  using (portfolio_id in (select id from portfolios where profile_id = auth.uid()));

-- Admins get full control, checked server-side via the is_admin() helper.
create policy "admin all profiles"   on profiles   for all using (is_admin());
create policy "admin all portfolios" on portfolios for all using (is_admin());
create policy "admin all holdings"   on holdings   for all using (is_admin());
create policy "admin all trades"     on trades     for all using (is_admin());
create policy "admin all leagues"    on leagues    for all using (is_admin());
create policy "admin all members"    on league_members for all using (is_admin());
create policy "admin all seasons"    on seasons    for all using (is_admin());
