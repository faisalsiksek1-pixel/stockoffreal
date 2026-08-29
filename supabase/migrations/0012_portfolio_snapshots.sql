-- One row per (portfolio, day): what the portfolio was worth the last time
-- its owner had it recorded that day. No cron — recorded as a side effect of
-- loading the dashboard, same "checked on your next visit" posture
-- fillDueOrders/checkRankChange already established. A day with no visit
-- simply has no row; the chart just has a gap, same as this app already
-- accepts pending orders sitting unfilled between visits.
--
-- Publicly readable, matching trades/holdings — portfolio performance is
-- already public in this schema (the whole leaderboard depends on it), so a
-- snapshot history is the same category of fact, not a new privacy question.
-- Writable only by the portfolio's own owner: a narrow, plain RLS policy is
-- enough here (no SECURITY DEFINER function needed) because, unlike a trade,
-- recording your own already-computed value can't affect anyone else's cash
-- or holdings — there's nothing here for a function to authorize beyond
-- "is this your own portfolio," which the policy already states directly.

create table portfolio_snapshots (
  portfolio_id      uuid not null references portfolios(id) on delete cascade,
  snapshot_date     date not null,
  total_value       numeric(18,2) not null,
  total_return_pct  numeric(10,6) not null,
  updated_at        timestamptz not null default now(),

  primary key (portfolio_id, snapshot_date)
);

create index portfolio_snapshots_portfolio_idx on portfolio_snapshots (portfolio_id, snapshot_date);

alter table portfolio_snapshots enable row level security;

create policy "snapshots readable" on portfolio_snapshots for select using (true);

create policy "snapshots writable by owner" on portfolio_snapshots for insert with check (
  exists (select 1 from portfolios p where p.id = portfolio_snapshots.portfolio_id and p.profile_id = auth.uid())
);

create policy "snapshots updatable by owner" on portfolio_snapshots for update using (
  exists (select 1 from portfolios p where p.id = portfolio_snapshots.portfolio_id and p.profile_id = auth.uid())
);
