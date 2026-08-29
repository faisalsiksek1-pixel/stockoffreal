-- Lets a league member record today's snapshot for that league's AI/Market
-- competitor portfolios — needed for the dashboard's overlaid equity-race
-- chart. Unlike a player's own portfolio_snapshots row (a plain owner-only
-- RLS policy, see 0012's header), an ai/benchmark portfolio has no owning
-- user to log the visit as, so recording it needs a SECURITY DEFINER
-- function instead of a write policy — same shape as markChatRead/
-- checkRankChange recording something on the caller's behalf, just for a
-- portfolio the caller doesn't own.
--
-- Not a privacy expansion: the ai/benchmark value being recorded is already
-- computed and shown to any league member (getSpecialCompetitors, publicly
-- readable portfolios) — this only persists a number the caller could
-- already see, still gated to require the caller be a member of that
-- portfolio's own league.

create or replace function record_competitor_snapshot(
  p_portfolio_id     uuid,
  p_total_value       numeric,
  p_total_return_pct  numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_league uuid;
  v_owner  portfolio_owner;
begin
  if v_actor is null then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;

  select league_id, owner_type into v_league, v_owner
    from portfolios where id = p_portfolio_id;

  if v_league is null or v_owner not in ('ai', 'benchmark') then
    raise exception 'Not a competitor portfolio.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from portfolios p where p.league_id = v_league and p.profile_id = v_actor
  ) then
    raise exception 'You are not a member of this league.' using errcode = '42501';
  end if;

  insert into portfolio_snapshots (portfolio_id, snapshot_date, total_value, total_return_pct, updated_at)
  values (p_portfolio_id, current_date, p_total_value, p_total_return_pct, now())
  on conflict (portfolio_id, snapshot_date)
  do update set total_value = excluded.total_value,
                total_return_pct = excluded.total_return_pct,
                updated_at = now();
end;
$$;

grant execute on function record_competitor_snapshot(uuid, numeric, numeric) to authenticated;
