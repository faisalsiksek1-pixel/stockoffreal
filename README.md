# StockOff

A mobile-first social investing simulator. Every player starts with **$100,000 in
simulated cash** and competes over a season against their friends, an AI
portfolio, a human-managed portfolio, and the S&P 500.

> StockOff is a simulated investing game. It does not involve real money and does
> not provide financial advice. Simulated results do not represent guaranteed
> real-world performance.

The core journey is deliberately short — landing page → sign up → search a stock
→ place a simulated buy → see your rank — and is meant to be completable on a
phone in under two minutes.

---

## Table of contents

- [Stack](#stack)
- [Architecture](#architecture)
- [Folder structure](#folder-structure)
- [Database](#database)
- [Setup](#setup)
- [Local development](#local-development)
- [Tests](#tests)
- [Deployment](#deployment)
- [Market data](#market-data)
- [Admin](#admin)
- [Security model](#security-model)
- [Limitations](#limitations)

---

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19, TypeScript (strict) |
| Styling | Tailwind CSS v4 |
| Database / auth | Supabase (Postgres + Auth + RLS) |
| Validation | Zod |
| Tests | Vitest, plus PGlite (Postgres compiled to WASM) for schema tests |
| Hosting | Vercel |

TypeScript runs with `strict`, `noUncheckedIndexedAccess` and `noUnusedLocals`.

---

## Architecture

Three decisions shape everything else.

**1. Every competitor is a row in one `portfolios` table.**
Users, the AI, the Human and the S&P 500 benchmark are all portfolios,
distinguished by an `owner_type` enum (`user` / `ai` / `human` / `benchmark`).
The leaderboard is therefore a single query over a single table rather than a
union of four different shapes, and every competitor is valued by the same code
path — which is the only way the comparison is honest. The benchmark simply
holds an S&P 500 ETF for the whole season, so its return is the index's return
measured from the same $100,000 start with the same prices as everybody else.

**2. All money movement goes through one Postgres function.**
`execute_trade(portfolio_id, symbol, side, shares, price)` takes a
`SELECT … FOR UPDATE` row lock on the portfolio, then re-checks cash (buys) or
share count (sells) inside the transaction before writing the holding and the
trade row. Two simultaneous requests cannot both pass the same cash check,
because the second waits for the first to commit.

Nothing else in the system may write `portfolios`, `holdings` or `trades` —
there is no user-facing RLS policy that permits it, for any of the three. That
includes cash: RLS cannot restrict an `UPDATE` to a single column, so a policy
letting a user update their own portfolio row would equally let them
`set cash = 99999999` from the browser with the public anon key. Because users
therefore hold no write policy, `execute_trade` must be `SECURITY DEFINER`, and
because definer rights bypass RLS it performs the ownership check itself: you may
trade your own portfolio and nothing else. The AI, Human and benchmark portfolios
have a null owner, so they are reachable only by an admin or by server-side
seeding.

**3. Prices are resolved server-side, always.**
The client submits a symbol, a side and a quantity. It never submits a price or a
balance. `src/actions/trade.ts` validates the input with Zod, looks the price up
from the market-data service, and passes that price to `execute_trade`. A user
editing the request payload can change *what* they trade, never *at what price*.

### Request flow for a trade

```
TradePanel (client)          → symbol, side, dollars|shares
  → placeOrder server action → Zod validation
                             → auth check (own portfolio only)
                             → server-side price lookup
                             → resolveOrder() pre-flight
  → execute_trade() RPC      → FOR UPDATE lock
                             → cash / share check
                             → upsert holding, insert trade, update cash
  → revalidate + refresh     → dashboard, portfolio, leaderboard
```

`src/lib/trade-rules.ts` mirrors the SQL rules in TypeScript. It is used for the
order preview so the user sees "not enough cash" *before* submitting, and it is
what the unit tests exercise. It is a convenience and a test surface — the SQL
function is the enforcement.

### Market data

`src/lib/market/` is isolated behind a `MarketDataProvider` interface so the data
vendor can be swapped without touching the app:

- `MockProvider` — deterministic seeded random walk, stable per symbol per UTC
  day. No API key needed and the app is fully usable on it.
- `FinnhubProvider` — delayed real quotes.
- `marketData()` picks by `MARKET_DATA_PROVIDER` and **falls back to mock if the
  key is missing**, so a bad deploy degrades to a working app rather than a
  broken one.

Season One trades a curated list of 22 large-cap stocks and ETFs
(`src/lib/market/instruments.ts`) rather than the whole market, which keeps quote
fan-out inside free API tiers and keeps search results meaningful.

---

## Folder structure

```
supabase/migrations/0001_init.sql   Full schema: tables, enums, functions, RLS
scripts/seed.ts                    Idempotent season seeder

src/
  app/
    page.tsx                       Landing: scoreboard + "Start with $100K"
    login/  signup/                Auth
    leaderboard/                   Public season leaderboard (no login needed)
    admin/                         Admin console (re-checks is_admin)
    (app)/                         Authenticated shell with bottom nav
      dashboard/                   Value, day change, rank, the race, holdings
      trade/                       Search → preview → submit
      portfolio/                   Holdings, weights, trade history
      leagues/                     Create / join
      leagues/[code]/              A private league's board
      profile/                     Username, sign out
      share/                       Shareable result card
  actions/
    trade.ts                       placeOrder — the only trade entry point
    auth.ts                        signUp / signIn / signOut
    leagues.ts                     createLeague / joinLeague
    admin.ts                       Admin-only actions, each gated on requireAdmin
  lib/
    portfolio.ts                   Pure valuation + ranking (no I/O)
    trade-rules.ts                 Pure order resolution, mirrors the SQL
    queries.ts                     All read queries
    market/                        Provider interface, mock, Finnhub, instruments
    supabase/{client,server}.ts    Browser and server (SSR cookie) clients
    format.ts  types.ts
  components/                      UI, including ui/ primitives
  middleware.ts                    Session refresh + private-route guard

tests/
  trading.test.ts                  Money logic, pure (26 tests)
  market.test.ts                   Provider behaviour (9 tests)
  access.test.ts                   Source-level invariants (19 tests)
  schema.test.ts                   Migration + RLS, on a real Postgres (26 tests)
  helpers/pgtest.ts                Boots PGlite, applies the migration, fakes auth
```

---

## Database

Eight tables. RLS is enabled on all of them.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `seasons` | A competition period | `slug`, `starting_balance`, `is_active` |
| `profiles` | One row per auth user | `id` → `auth.users`, `username`, `is_admin` |
| `portfolios` | Every competitor | `season_id`, `owner_type`, `profile_id`, `cash`, `starting_balance`, `strategy_note` |
| `holdings` | Current positions | `portfolio_id`, `symbol`, `shares`, `avg_cost` |
| `trades` | Immutable order log | `portfolio_id`, `symbol`, `side`, `shares`, `price`, `amount` |
| `leagues` | Public and private | `season_id`, `name`, `code`, `is_public`, `created_by` |
| `league_members` | Join table | `league_id`, `portfolio_id` |
| `price_cache` | Last known quotes | `symbol`, `price`, `prev_close`, `updated_at` |

### Relationships

```
auth.users ──1:1── profiles ──1:1── portfolios ──1:N── holdings
                                        │        └──1:N── trades
                                        │
seasons ──1:N── portfolios              └──N:M── leagues (via league_members)
        └──1:N── leagues
```

A unique index (`one_special_per_season`) guarantees at most one AI, one Human
and one benchmark portfolio per season, so the race can never show duplicates.

### Functions

| Function | Notes |
| --- | --- |
| `execute_trade` | Row-locked, validating trade execution. The only writer of `portfolios.cash`, `holdings` and `trades`. Definer rights, with its own ownership check. |
| `bootstrap_new_user` | `SECURITY DEFINER`. Creates profile + portfolio and joins the active public league, in one transaction. |
| `join_league_by_code` | `SECURITY DEFINER`. Lets a user join a private league by code without being able to read every league's code. |
| `league_preview` | `SECURITY DEFINER`. Name and member count for an invite code, so a non-member can see what they are joining. |
| `is_admin` | Reads `profiles.is_admin` for the current user; used by the admin RLS policies. |
| `jwt_role` | The request JWT's role claim. Used instead of `current_user`, which reports the definer inside a `SECURITY DEFINER` function. |

Private leagues are readable only by their members, because the row contains the
invite code — a blanket public read would publish every code. Someone arriving on
an invite link gets a join prompt built from `league_preview` instead.

---

## Setup

Requires Node 20+.

**Quick path.** After `npm install`, create a Supabase project and paste its three
keys into `.env.local`, then:

```bash
npm run setup
```

That checks the environment, tells you the one manual step (applying the schema —
it copies the SQL to your clipboard and gives you the direct link), and seeds the
season. Re-run it as often as you like; it only does what is still outstanding.
The long-hand version of the same thing follows.

**1. Install**

```bash
npm install
```

**2. Create a Supabase project**

Create a free project at [supabase.com](https://supabase.com). From
**Project Settings → API**, copy the project URL, the `anon` key and the
`service_role` key.

**3. Configure environment**

```bash
cp .env.example .env.local
```

Fill in:

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Safe in the browser; RLS constrains it |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **Server only.** Never prefix with `NEXT_PUBLIC_` |
| `MARKET_DATA_PROVIDER` | no | `mock` (default) or `finnhub` |
| `FINNHUB_API_KEY` | no | Only if using `finnhub` |
| `ADMIN_EMAILS` | no | Comma-separated; these emails get admin on signup |

`.env.local` is gitignored. Do not commit real keys.

**4. Run the migration**

Open the Supabase **SQL Editor**, paste the contents of
`supabase/migrations/0001_init.sql`, and run it. Or with the Supabase CLI:

```bash
supabase db push
```

**5. Seed the season**

```bash
npm run setup
```

This creates Season One, the flagship public league (`SEASON1`, "StockOff
League"), and its AI opponent's portfolio. No demo user accounts are
created — the leaderboard starts empty, ready for real signups. It is
idempotent — re-running wipes and rebuilds the seeded season.

---

## Local development

```bash
npm run dev
```

Then open http://localhost:3000. Other scripts:

```bash
npm run setup        # guided first-time setup (env check, schema, seed)
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run test:watch   # vitest
npm run build        # production build
npm run seed         # reseed the season
```

Best viewed at a phone width — the layout is mobile-first with a bottom nav, and
scales up to desktop.

---

## Tests

```bash
npm run test
```

80 tests across four files. No database setup is needed — the schema suite starts
its own Postgres in-process:

- **`trading.test.ts`** — starting balance is exactly $100,000; buy costs
  shares × price; dollar amounts convert to fractional shares rounding *down*;
  overspending is rejected; overselling is rejected; selling an unheld stock is
  rejected; a sell is bounded by the position and never by cash; average cost is
  share-weighted; P&L, weights and day change; leaderboard ranks by percentage
  return with a stable name tiebreak; a missing quote falls back to average cost
  rather than to zero (a failed price lookup must not look like a total loss).
- **`market.test.ts`** — mock prices are deterministic per symbol per day, stay
  positive, cover every instrument, and the provider falls back to mock when a
  real provider is configured without a key.
- **`schema.test.ts`** — boots a real Postgres in-process (PGlite), applies
  `0001_init.sql`, stubs Supabase's `auth` schema and its `anon` /
  `authenticated` / `service_role` roles, then asserts on actual behaviour:
  signup bootstrap; buy, sell, weighted average cost, overspend and oversell
  rejection; a player *can* trade their own book and *cannot* trade anyone
  else's, the AI's, or trade while anonymous; direct attempts to edit cash,
  fabricate a holding or forge a trade all fail; league creation, membership
  scoping, private-code confidentiality, preview-then-join; and anonymous
  leaderboard reads. This suite found four defects that the unit tests,
  typecheck and production build all passed over — see the header comment in
  the file.
- **`access.test.ts`** — every exported admin action calls `requireAdmin()`
  *before* constructing the service-role client; the service key is never
  `NEXT_PUBLIC_`; RLS is enabled on all eight tables; users have no direct write
  policy on `portfolios`, `holdings` or `trades`; `execute_trade` contains
  `FOR UPDATE`, is `SECURITY DEFINER`, and checks ownership *before* any write;
  every definer function pins `search_path`; the leagues read policy is not
  `using (true)`; every RPC call site's function name and argument names match
  the SQL signatures (PostgREST binds arguments by name, so a rename is a silent
  runtime failure); the middleware guards every private route prefix.

---

## Deployment

### Supabase

1. Create a production project.
2. Run `supabase/migrations/0001_init.sql` in the SQL Editor.
3. **Authentication → Providers → Email**: enable it. For a smoother demo you can
   turn off "Confirm email"; leave it on for real users.
4. **Authentication → URL Configuration**: set the Site URL to your Vercel domain
   and add it to the redirect allow-list.
5. Optionally seed: point `.env.local` at the production project and run
   `npm run setup`.

### Vercel

1. Push the repo to GitHub and import it at [vercel.com/new](https://vercel.com/new).
   Framework preset: Next.js. No build overrides needed.
2. Add the environment variables under **Settings → Environment Variables**:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, and optionally `MARKET_DATA_PROVIDER`,
   `FINNHUB_API_KEY`, `ADMIN_EMAILS`.
   Apply them to Production, Preview and Development.
3. Deploy. Then go back to Supabase and set the Site URL to the real domain.

Redeploy after changing environment variables — Next.js inlines
`NEXT_PUBLIC_*` values at build time.

---

## Market data

Default is `mock`: a deterministic seeded walk that produces plausible prices,
identical for all users on a given UTC day, with no API key and no rate limits.
The app is complete and demoable this way.

For delayed real quotes, get a free [Finnhub](https://finnhub.io) key and set:

```
MARKET_DATA_PROVIDER=finnhub
FINNHUB_API_KEY=your-key
```

The key is read server-side only and is never sent to the browser. Sparkline
history always comes from the mock walk, because candle data is not on most free
tiers.

To add a vendor, implement `MarketDataProvider` in `src/lib/market/` and register
it in `marketData()`. Nothing outside that folder needs to change.

---

## Admin

There are no seeded test accounts — sign up for real, then grant yourself admin
either by setting `ADMIN_EMAILS` before signing up, or by running:

```sql
update profiles set is_admin = true where username = 'your_name';
```

`/admin` is available to users with `profiles.is_admin = true`. The page re-checks
the flag server-side and redirects otherwise — the middleware guard is not the
only defence. From there an admin can rebalance the flagship AI's portfolio,
rename a player, create a season, end a season, and reset balances.

Every admin action calls `requireAdmin()` before it constructs the service-role
client, so an unauthorised caller never reaches escalated credentials. A test
asserts this ordering, because getting it backwards is the kind of mistake that
looks fine in review.

---

## Security model

- **Server-side validation only.** Prices and balances are never accepted from
  the client. Orders are Zod-validated, then priced and executed server-side.
- **Concurrency.** `execute_trade` locks the portfolio row with `FOR UPDATE`, so
  two simultaneous trades cannot overspend the same balance.
- **RLS on every table.** Leaderboard-relevant data (usernames, portfolio values,
  holdings, trades) is publicly readable, because the game is a public
  competition. Private league rows are members-only, since they carry the invite
  code. Writes are scoped: a user can update their own profile and add their own
  portfolio to a league — nothing else. There is no user write policy on
  `portfolios`, `holdings` or `trades` at all.
- **Auth email addresses stay private** — they live in `auth.users`, which is not
  exposed. Public reads see usernames only.
- **Secrets.** The service-role key and market-data key are server-only. A test
  asserts neither is `NEXT_PUBLIC_`.
- **Route protection.** `src/middleware.ts` refreshes the session and redirects
  unauthenticated requests away from private routes, preserving the intended
  destination in `?next=`. Pages re-verify server-side.

---

## Limitations

Known and deliberate, for an MVP:

1. **Simulated money only.** No real trading, deposits, withdrawals, brokerage
   connections or options. Short selling is supported, gated by 1:1 cash
   collateral rather than a real margin system. Leverage (1x-20x, chosen per
   order) scales buying power only — there is no interest and no margin call.
   No financial advice.
2. **Prices are mock by default**, and even with Finnhub they are delayed. Fills
   are instant at the last known price, with no spread, slippage, commission,
   market hours or liquidity limits. A real market would not fill you like this.
3. **No historical equity curve.** Portfolio value is computed live from current
   prices. The dashboard's equity series is derived from the trade log, not from
   daily snapshots, so it is illustrative rather than an audited track record.
   A daily snapshot table is the natural next migration.
4. **Fixed instrument list** — 22 symbols. Search will not find anything else.
5. **Three layers are still unexercised.** `0001_init.sql` and its RLS policies
   now run for real in `schema.test.ts`, but three things above them do not:
   **PostgREST** (the HTTP layer Supabase puts in front of Postgres — the schema
   tests call the functions directly, so argument binding is only checked
   statically, see the rpc contract tests), **Supabase Auth** (signup, sessions,
   cookie refresh), and **`npm run seed`**, which needs the auth admin API and so
   has never been run. Completing one signup → trade → leaderboard pass against
   a real project remains the last verification step.
6. **Concurrency is proven by construction, not by test.** The `FOR UPDATE` lock
   is the guarantee, and it is the one claim in this README that no test here
   backs: PGlite is a single connection, so two simultaneous trades cannot be
   staged. Verifying it needs two concurrent sessions against a server Postgres.
7. **No linter is configured.** `next lint` is deprecated in Next 15 and removed
   in 16, and the script was dropped rather than left as a command that opens an
   interactive prompt. ESLint with `eslint-config-next` is a straightforward
   addition.
8. **The AI portfolio is not autonomous here.** It holds a fixed Season One
   allocation, rebalanced by an admin. The decision engine lives outside this
   app.
9. **No email verification flow in the UI**, no password reset, no social login.
10. **Leaderboard recomputes on request.** Fine at demo scale; at real scale it
   needs a materialised view or a cached snapshot.
11. **Season lifecycle is manual.** Ending a season and starting the next is an
   admin button, not a schedule.

### On leaderboard language

Leaders are described as **top-performing players for that season** — never as
the "best investor". A season of simulated trading measures one run of one
strategy over one short window; that is not a statement about anybody's skill,
and the copy should not imply it is.
