-- Teams: a private-league creator may group members into named teams, each
-- with its own passcode, separate from the league's own invite code. A team
-- passcode joins the league (if needed) AND assigns the joiner to that team
-- in one step, via join_team_by_code — mirrors join_league_by_code's shape.
--
-- Column-visibility problem: teams.code must be as protected as a league's
-- own code (anyone who can read it can impersonate the passcode), but every
-- league member needs to see every OTHER team's NAME for leaderboard badges
-- and team standings. RLS is row-level, not column-level, and this schema
-- assumes a hostile caller hits the REST API directly with a valid JWT — so
-- "the app just doesn't SELECT code" is not protection.
--
-- Fix: the general teams SELECT policy is narrow — only a team's own creator
-- or member can read the row at all, same shape as "leagues readable" gating
-- leagues.code, just one level narrower (a league's own code is visible to
-- every member; a team's code is not visible to every league member, only
-- that team's own). Anyone who needs team NAMES ONLY goes through
-- league_teams(), which mirrors league_preview()'s precedent exactly: a
-- SECURITY DEFINER function with no auth/membership check, deliberately
-- narrow in the columns it returns.
--
-- No admin/service_role clause is needed in either teams RLS policy:
-- service_role bypasses RLS entirely at the Postgres role level (same reason
-- "leagues readable" has no such clause either) — that bypass only needs
-- reconstructing inside a SECURITY DEFINER function, which runs with RLS off
-- by definition.
--
-- Team creation is a plain client-side INSERT guarded entirely by RLS, not a
-- function: createLeague already inserts directly into `leagues` from
-- TypeScript and retries on a code collision; teams follow the identical
-- pattern rather than duplicating that authorization inside a new RPC.

create table teams (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references leagues(id) on delete cascade,
  name       text not null,
  code       text not null unique,
  created_by uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),

  constraint teams_name_length check (char_length(btrim(name)) between 1 and 40)
);

create index teams_league_id_idx on teams (league_id);

alter table portfolios add column team_id uuid references teams(id) on delete set null;

create index portfolios_team_id_idx on portfolios (team_id);

-- Belt-and-suspenders, not a fix for a live hole: portfolios has no UPDATE
-- policy for regular users at all (every mutation goes through a SECURITY
-- DEFINER function), and the only function that ever sets team_id
-- (join_team_by_code) derives both the team and the league it creates/finds
-- the portfolio in from the same team row, so they can never disagree today.
-- This guards the invariant regardless of what future write path exists.
create or replace function enforce_portfolio_team_same_league() returns trigger
language plpgsql
as $$
begin
  if new.team_id is not null and not exists (
    select 1 from teams t where t.id = new.team_id and t.league_id = new.league_id
  ) then
    raise exception 'Team % does not belong to league %.', new.team_id, new.league_id
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger portfolios_team_league_match
  before insert or update of team_id, league_id on portfolios
  for each row execute function enforce_portfolio_team_same_league();

alter table teams enable row level security;

-- The only channel that exposes `code` — a team's own creator or member.
create policy "teams readable by creator or member" on teams for select using (
  created_by = auth.uid()
  or exists (
    select 1 from portfolios p
     where p.team_id = teams.id and p.profile_id = auth.uid()
  )
);

-- Only the league's creator may add a team to it. RLS alone gates this —
-- no function needed, mirroring how league creation itself is authorized.
create policy "teams insertable by league creator" on teams for insert with check (
  exists (
    select 1 from leagues l
     where l.id = teams.league_id and l.created_by = auth.uid()
  )
);

-- No update/delete policy: teams are neither renamed nor deleted in this
-- version. Default-deny for authenticated/anon.

-- Narrow, permissive, names-only lookup — exact mirror of league_preview.
-- No auth/membership check: knowing a league id is enough to see what teams
-- exist and what they're called, never their codes.
create or replace function league_teams(p_league_id uuid)
returns table(id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.name from teams t where t.league_id = p_league_id order by t.name;
$$;

grant execute on function league_teams(uuid) to anon, authenticated;

-- Resolves a team by its passcode, joins the caller to the team's league
-- (idempotent, via the existing create_portfolio_in_league) and assigns
-- them to the team in the same call. Re-entering a different team's code
-- re-assigns team_id — switching teams is not blocked, matching this app's
-- existing posture (rejoining a league is already idempotent, not blocked).
create or replace function join_team_by_code(p_code text) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team         teams%rowtype;
  v_uid          uuid := auth.uid();
  v_username     text;
  v_portfolio_id uuid;
  v_league_code  text;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select * into v_team from teams where upper(code) = upper(p_code);
  if v_team.id is null then
    raise exception 'No team with that code.' using errcode = '22023';
  end if;

  select username into v_username from profiles where id = v_uid;
  if v_username is null then
    raise exception 'No profile yet.' using errcode = '22023';
  end if;

  v_portfolio_id := create_portfolio_in_league(v_team.league_id, v_uid, v_username);
  update portfolios set team_id = v_team.id where id = v_portfolio_id;

  select code into v_league_code from leagues where id = v_team.league_id;

  return json_build_object(
    'league_id', v_team.league_id,
    'league_code', v_league_code
  );
end;
$$;

grant execute on function join_team_by_code(text) to authenticated;
