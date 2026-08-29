-- League chat: one message thread per league, visible and postable only to
-- confirmed members (a portfolios row exists for league_id + auth.uid()) —
-- deliberately NOT extending the "leagues readable" is_public bypass to chat.
-- Every other table here is public because publicness is the product (a
-- rankable, comparable leaderboard); chat is human-authored free text between
-- real people, a different privacy expectation entirely, so a random visitor
-- to the public leaderboard should never see or post to it. Every signed-up
-- user auto-joins the flagship league at signup (bootstrap_new_user), so real
-- members lose nothing from this being membership-gated rather than public.
--
-- sender_portfolio_id, not profile_id: same reason trades.portfolio_id and
-- pending_orders.portfolio_id are — display_name/owner_type come for free
-- with zero joins, and it makes an AI/benchmark portfolio structurally unable
-- to post (their profile_id is null; post_league_message's ownership lookup
-- can never resolve a real auth.uid() to one).
--
-- league_id is stored directly on the row too, even though it is derivable
-- through sender_portfolio_id -> portfolios.league_id — same call 0004 made
-- for portfolios.season_id. Here it's what the SELECT policy's membership
-- check and its index key on, so deriving it via a join would cost a join on
-- every row read and every policy evaluation, not just at insert time.
--
-- Write model follows 0007_pending_orders.sql's convention, not 0001's: users
-- get a select policy and nothing else, every mutation goes through a
-- SECURITY DEFINER function, and there is no blanket "admin all
-- league_messages" RLS policy — the admin bypass lives only inside
-- delete_league_message, keeping authorization in one place.
-- post_league_message has NO admin/service-role bypass: an admin with no
-- portfolio in a league has no identity to post as, unlike execute_trade
-- where the admin is manipulating an existing account. delete_league_message
-- DOES get the bypass — moderation, same shape as every other
-- "owner or admin or service_role" check in this schema.
--
-- on delete cascade on sender_portfolio_id mirrors trades/holdings/
-- pending_orders. Currently unreachable in practice (nothing in this app ever
-- deletes a portfolio), but noted so a future "leave a league" feature
-- doesn't silently wipe chat history as a surprise side effect.
--
-- 500-character cap is enforced twice: a table CHECK (defense in depth
-- against a future direct/service-role insert bypassing the function) and a
-- friendly raise exception inside post_league_message (what a player sees) —
-- same doubling place_limit_order already does for quantity/price.

create table league_messages (
  id                   uuid primary key default gen_random_uuid(),
  league_id            uuid not null references leagues(id) on delete cascade,
  sender_portfolio_id  uuid not null references portfolios(id) on delete cascade,
  body                 text not null,
  created_at           timestamptz not null default now(),

  constraint league_messages_body_length check (char_length(body) between 1 and 500)
);

create index league_messages_league_created_idx on league_messages (league_id, created_at, id);
create index league_messages_sender_idx on league_messages (sender_portfolio_id);

alter table league_messages enable row level security;

create policy "league messages readable" on league_messages for select using (
  exists (
    select 1 from portfolios p
     where p.league_id = league_messages.league_id
       and p.profile_id = auth.uid()
  )
);

-- Post a message as the caller's own portfolio in that league. No
-- admin/service-role bypass — see file header.
create or replace function post_league_message(p_league_id uuid, p_body text) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_portfolio_id uuid;
  v_body         text := btrim(p_body);
  v_message_id   uuid;
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

  select id into v_portfolio_id
    from portfolios
   where league_id = p_league_id and profile_id = v_actor;

  if not found then
    raise exception 'You are not a member of this league.' using errcode = '42501';
  end if;

  -- Blunts trivial scripted flooding without a rate-limiting subsystem: one
  -- message per second per sender.
  if exists (
    select 1 from league_messages
     where sender_portfolio_id = v_portfolio_id
       and created_at > now() - interval '1 second'
  ) then
    raise exception 'You are posting too fast, try again in a moment.' using errcode = '22023';
  end if;

  insert into league_messages (league_id, sender_portfolio_id, body)
  values (p_league_id, v_portfolio_id, v_body)
  returning id into v_message_id;

  return v_message_id;
end;
$$;

-- Delete a message. Sender may delete their own; admin/service-role may
-- delete anyone's (moderation) — mirrors cancel_limit_order almost verbatim.
create or replace function delete_league_message(p_message_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_owner uuid;
begin
  select p.profile_id into v_owner
    from league_messages m
    join portfolios p on p.id = m.sender_portfolio_id
   where m.id = p_message_id
     for update of m;

  if not found then
    raise exception 'Message not found.' using errcode = '42501';
  end if;

  if not (
    (v_actor is not null and v_owner is not null and v_owner = v_actor)
    or is_admin()
    or coalesce(jwt_role(), '') = 'service_role'
  ) then
    raise exception 'You can only delete your own messages.' using errcode = '42501';
  end if;

  delete from league_messages where id = p_message_id;
end;
$$;
