-- Per-user "have I seen this" tracking, one row per (profile, league). Powers
-- two lightweight indicators computed on page load — no push, no background
-- job, same "checked on your next visit" posture fillDueOrders already
-- established for limit orders.

create table league_visits (
  profile_id     uuid not null references profiles(id) on delete cascade,
  league_id      uuid not null references leagues(id) on delete cascade,
  last_read_at   timestamptz not null default now(),
  last_seen_rank int,
  updated_at     timestamptz not null default now(),

  primary key (profile_id, league_id)
);

alter table league_visits enable row level security;

-- Purely a user's own preference row — no cross-user visibility question
-- like teams/chat had, so one policy covers every operation.
create policy "own visit rows" on league_visits for all
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Unread counts per league in one query. Deliberately NOT security definer:
-- it runs as the caller, so league_messages' own membership-gated RLS (see
-- 0009_league_chat.sql) still applies — a league the caller isn't a member
-- of just contributes 0 rows, the same as if it weren't passed in at all.
create or replace function unread_chat_counts(p_league_ids uuid[])
returns table(league_id uuid, unread_count bigint)
language sql
stable
as $$
  select m.league_id, count(*) as unread_count
  from league_messages m
  left join league_visits v on v.league_id = m.league_id and v.profile_id = auth.uid()
  where m.league_id = any(p_league_ids)
    and m.created_at > coalesce(v.last_read_at, '-infinity'::timestamptz)
  group by m.league_id;
$$;

grant execute on function unread_chat_counts(uuid[]) to authenticated;
