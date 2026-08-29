-- Competitions: every signup auto-joins one flagship competition
-- ("StockOff Competition"), and each competition a user is in gives them an
-- independent portfolio — separate cash, holdings and trade history — rather
-- than one portfolio being shared across every league they belong to.
--
-- A `portfolios` row now *is* a (user, competition) membership: it gets a
-- `league_id`, and `league_members` (the old many-to-many join table) is
-- fully redundant once that's true — its only other column, `joined_at`, is
-- replaceable by `portfolios.created_at`. Dropped below.
--
-- `season_id` stays on `portfolios` rather than being derived through
-- `leagues` on every read: every portfolio-creation path in this file sets
-- both from the same league row in one statement, so they cannot drift, and
-- `adminResetBalances` and the existing `one_special_per_season` index need
-- no change at all.
--
-- Special competitors (AI/Human/benchmark) continue to be created only for
-- the flagship competition, never duplicated into user-created ones — a
-- private competition ranks user portfolios against each other only.

-- ---------------------------------------------------------------------------
-- 1. Add league_id (nullable for now) and backfill.
-- ---------------------------------------------------------------------------
alter table portfolios add column league_id uuid references leagues(id) on delete cascade;

-- A portfolio that was in more than one league today can only carry one
-- forward. Its public (flagship) membership wins over a private one — the
-- flagship carries the special competitors and is the leaderboard of record,
-- so it should win ties, not whichever league happened to be joined first.
update portfolios p
   set league_id = m.league_id
  from (
    select distinct on (m.portfolio_id) m.portfolio_id, m.league_id
      from league_members m
      join leagues l on l.id = m.league_id
     order by m.portfolio_id, l.is_public desc, m.joined_at asc
  ) m
 where m.portfolio_id = p.id;

do $$
declare
  v_stranded int;
begin
  select count(*) into v_stranded
    from league_members m
   where not exists (
     select 1 from portfolios p where p.id = m.portfolio_id and p.league_id = m.league_id
   );
  raise notice
    'competitions backfill: % league_members row(s) not carried forward (multi-league portfolios keep only their public/earliest league; rejoin the others to get a fresh portfolio in them).',
    v_stranded;
end $$;

-- Portfolios with no league_members row at all (e.g. signed up before any
-- public league existed) get attached to their season's flagship, creating
-- one named 'StockOff Competition' if that season still has none. This also
-- guarantees, as a side effect, that every season with any portfolios in it
-- ends this migration with a flagship competition ready to receive members.
do $$
declare
  r record;
  v_league_id uuid;
begin
  for r in select id, season_id from portfolios where league_id is null loop
    select id into v_league_id from leagues
     where season_id = r.season_id and is_public
     order by created_at limit 1;

    if v_league_id is null then
      insert into leagues (season_id, name, code, is_public)
      values (r.season_id, 'StockOff Competition', 'STOCKOFF-' || substr(r.season_id::text, 1, 8), true)
      returning id into v_league_id;
    end if;

    update portfolios set league_id = v_league_id where id = r.id;
  end loop;
end $$;

alter table portfolios alter column league_id set not null;

-- ---------------------------------------------------------------------------
-- 2. Uniqueness: a portfolio is now scoped per (user, competition), not per
--    (user, season). one_special_per_season is untouched — see file header.
-- ---------------------------------------------------------------------------
alter table portfolios drop constraint one_user_portfolio_per_season;
alter table portfolios add constraint one_portfolio_per_league_member unique (league_id, profile_id);

-- ---------------------------------------------------------------------------
-- 3. Drop league_members and its policies; portfolios.league_id replaces it.
--
--    Everything that references league_members has to be repointed at
--    portfolios BEFORE the table is dropped, not after — both league_preview
--    (a `language sql` function, whose body is parsed into a real dependency
--    at definition time, unlike the plpgsql functions in this file) and the
--    "leagues readable" policy (RLS policy expressions are dependency-tracked
--    the same way). Dropping the table first fails with "cannot drop table
--    league_members because other objects depend on it".
-- ---------------------------------------------------------------------------
create or replace function league_preview(p_code text)
returns table (id uuid, name text, member_count bigint)
language sql stable security definer set search_path = public
as $$
  select l.id,
         l.name,
         (select count(*) from portfolios p
           where p.league_id = l.id and p.owner_type = 'user')
    from leagues l
   where upper(l.code) = upper(p_code);
$$;

drop policy "leagues readable" on leagues;
create policy "leagues readable" on leagues for select using (
  is_public
  or created_by = auth.uid()
  or exists (
    select 1 from portfolios p
     where p.league_id = leagues.id and p.profile_id = auth.uid()
  )
);

drop policy "members readable" on league_members;
drop policy "join with own portfolio" on league_members;
drop policy "leave own league" on league_members;
drop policy "admin all members" on league_members;
drop table league_members;

-- ---------------------------------------------------------------------------
-- 4. The one place a user-owned portfolio gets created from now on.
-- ---------------------------------------------------------------------------
create or replace function create_portfolio_in_league(
  p_league_id     uuid,
  p_uid           uuid,
  p_display_name  text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_season       seasons;
  v_portfolio_id uuid;
begin
  -- Definer rights bypass RLS, so — same reasoning as execute_trade's
  -- ownership check — this has to guard explicitly against creating a
  -- portfolio on someone else's behalf. Every operand forced non-null for the
  -- same reason as there: a plain `v_actor = p_uid` is NULL, not false, for an
  -- unauthenticated caller, and `if not NULL then` would not fire.
  if not (
    (v_actor is not null and v_actor = p_uid)
    or is_admin()
    or coalesce(jwt_role(), '') = 'service_role'
  ) then
    raise exception 'Cannot create a portfolio for another user.' using errcode = '42501';
  end if;

  select s.* into v_season
    from leagues l join seasons s on s.id = l.season_id
   where l.id = p_league_id;

  if not found then
    raise exception 'Competition not found.' using errcode = '22023';
  end if;

  insert into portfolios (season_id, league_id, owner_type, profile_id, display_name,
                          cash, starting_balance)
  values (v_season.id, p_league_id, 'user', p_uid, p_display_name,
          v_season.starting_balance, v_season.starting_balance)
  on conflict (league_id, profile_id) do nothing
  returning id into v_portfolio_id;

  if v_portfolio_id is null then
    select id into v_portfolio_id
      from portfolios
     where league_id = p_league_id and profile_id = p_uid;
  end if;

  return v_portfolio_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. bootstrap_new_user: self-healing flagship creation, no more separate
--    league_members insert.
-- ---------------------------------------------------------------------------
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
  v_league_id    uuid;
  v_portfolio_id uuid;
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

  select id into v_league_id
    from leagues
   where season_id = v_season.id and is_public
   order by created_at limit 1;

  if v_league_id is null then
    insert into leagues (season_id, name, code, is_public)
    values (v_season.id, 'StockOff Competition', 'STOCKOFF-' || substr(v_season.id::text, 1, 8), true)
    returning id into v_league_id;
  end if;

  v_portfolio_id := create_portfolio_in_league(v_league_id, v_uid, p_username);

  return v_portfolio_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. join_league_by_code: creates a fresh portfolio instead of reusing one.
--    A signed-in user always already has at least the flagship portfolio by
--    the time they can call this, so the old "no portfolio in that season"
--    branch no longer applies.
-- ---------------------------------------------------------------------------
create or replace function join_league_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_league   leagues;
  v_username text;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select * into v_league from leagues where upper(code) = upper(p_code);
  if not found then
    raise exception 'No league with that code.' using errcode = '22023';
  end if;

  select username into v_username from profiles where id = v_uid;
  if v_username is null then
    raise exception 'No profile yet.' using errcode = '22023';
  end if;

  perform create_portfolio_in_league(v_league.id, v_uid, v_username);

  return v_league.id;
end;
$$;
