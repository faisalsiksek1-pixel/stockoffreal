-- Retires the Human and Market (S&P 500 benchmark) special competitors,
-- keeping only the AI — and lets a player spin up an independent "1v1 the
-- AI" competition, each with its own fresh AI portfolio.
--
-- That last part conflicts with the existing one_special_per_season index:
-- it allows exactly one 'ai'-owner_type portfolio per season, full stop,
-- which made sense when the AI only ever lived in the flagship competition.
-- Once a duel creates a second (and third, and Nth) 'ai' portfolio in the
-- same season — just in a different league — that index would reject it.
-- The invariant it should actually defend is "one special competitor per
-- LEAGUE", not per season, so it is re-keyed on league_id below.
--
-- The flagship league is renamed from its previous 'StockOff Competition' to
-- 'StockOff League', and bootstrap_new_user's self-healing fallback (for a
-- season that has no public league yet) is updated to match.

update leagues set name = 'StockOff League' where name = 'StockOff Competition';

-- Cascades remove their holdings and trades too.
delete from portfolios where owner_type in ('human', 'benchmark');

drop index one_special_per_season;
create unique index one_special_per_league on portfolios (league_id, owner_type)
  where owner_type <> 'user';

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
    values (v_season.id, 'StockOff League', 'STOCKOFF-' || substr(v_season.id::text, 1, 8), true)
    returning id into v_league_id;
  end if;

  v_portfolio_id := create_portfolio_in_league(v_league_id, v_uid, p_username);

  return v_portfolio_id;
end;
$$;
