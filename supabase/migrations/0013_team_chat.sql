-- Team chat: a message may optionally be scoped to a specific team
-- (team_id not null) instead of the whole league (team_id null). Extends
-- league_messages rather than a parallel table — a team channel is the same
-- conversational concept as league chat, just filtered narrower.
--
-- Must drop post_league_message before recreating it: adding a parameter
-- changes the signature, so create or replace would leave the old 2-argument
-- version behind as a second, ambiguous overload rather than replacing it —
-- same gotcha the leverage migration hit earlier this project.
--
-- The readable policy gains the same privacy boundary a team's own passcode
-- already gets (0010_teams.sql): a team-scoped message requires the caller
-- to be a member of THAT team, not just the league — a team's space stays
-- private to its own members even from other members of the same league.

alter table league_messages add column team_id uuid references teams(id) on delete cascade;

create index league_messages_team_idx on league_messages (team_id, created_at)
  where team_id is not null;

drop policy "league messages readable" on league_messages;

create policy "league messages readable" on league_messages for select using (
  exists (
    select 1 from portfolios p
     where p.league_id = league_messages.league_id
       and p.profile_id = auth.uid()
  )
  and (
    team_id is null
    or exists (
      select 1 from portfolios p
       where p.team_id = league_messages.team_id
         and p.profile_id = auth.uid()
    )
  )
);

drop function if exists post_league_message(uuid, text);

create or replace function post_league_message(p_league_id uuid, p_body text, p_team_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor          uuid := auth.uid();
  v_portfolio_id   uuid;
  v_portfolio_team uuid;
  v_body           text := btrim(p_body);
  v_message_id     uuid;
begin
  if v_actor is null then
    raise exception 'Sign in to chat.' using errcode = '42501';
  end if;

  if v_body is null or char_length(v_body) = 0 then
    raise exception 'Message cannot be empty.' using errcode = '22023';
  end if;
  if char_length(v_body) > 500 then
    raise exception 'Message is too long (500 characters max).' using errcode = '22023';
  end if;

  select id, team_id into v_portfolio_id, v_portfolio_team
    from portfolios
   where league_id = p_league_id and profile_id = v_actor;

  if not found then
    raise exception 'You are not a member of this league.' using errcode = '42501';
  end if;

  if p_team_id is not null and (v_portfolio_team is null or v_portfolio_team <> p_team_id) then
    raise exception 'You are not on that team.' using errcode = '42501';
  end if;

  if exists (
    select 1 from league_messages
     where sender_portfolio_id = v_portfolio_id
       and created_at > now() - interval '1 second'
  ) then
    raise exception 'You are posting too fast, try again in a moment.' using errcode = '22023';
  end if;

  insert into league_messages (league_id, sender_portfolio_id, body, team_id)
  values (p_league_id, v_portfolio_id, v_body, p_team_id)
  returning id into v_message_id;

  return v_message_id;
end;
$$;
