/**
 * A real Postgres to test the schema against.
 *
 * PGlite is Postgres compiled to WebAssembly, running in-process. That matters
 * because the defects worth catching in this schema do not live in any single
 * statement — they live in the interaction between the RLS policies and the
 * SECURITY DEFINER functions, which no amount of reading the SQL as text will
 * prove. Here the migration is actually executed and the policies are actually
 * enforced.
 *
 * Fidelity notes — what this harness has to reproduce about Supabase:
 *
 *   1. `auth.users`, `auth.uid()` and `auth.jwt()`. Supplied by Supabase in a real
 *      project; stubbed here exactly as Supabase defines them, reading the
 *      `request.jwt.claims` GUC that PostgREST sets per request.
 *   2. The `anon` / `authenticated` / `service_role` roles, and the table grants
 *      Supabase applies by default. The migration itself contains no GRANTs
 *      because Supabase's default privileges already cover them — so the harness
 *      must grant them too, or every query would fail on privileges rather than
 *      on the policy being tested, which would make these tests worthless.
 *   3. Superusers bypass RLS. Tests must therefore `set role` to a real role
 *      before asserting on anything policy-related; `asSuperuser()` is only for
 *      arranging fixtures.
 *
 * What it cannot reproduce: concurrency. PGlite is a single connection, so the
 * `FOR UPDATE` lock in execute_trade is not exercised here. See the README.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");
// Zero-padded numeric prefixes sort correctly as plain strings, same order
// Supabase applies them in.
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** Mirrors Supabase's auth schema closely enough for the policies to behave. */
const AUTH_SHIM = `
create schema if not exists auth;

create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Defined exactly as Supabase defines them: read from the per-request JWT claims
-- GUC. Returns null when unset, which is the anonymous case.
create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
      ''
    ), ''
  )::uuid;
$fn$;

create or replace function auth.jwt() returns jsonb
language sql stable as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$fn$;

create role anon;
create role authenticated;
create role service_role;
`;

/** The grants Supabase applies to the public schema by default. */
const GRANTS = `
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
`;

export interface TestDb {
  /** Run SQL, returning rows. Throws on error, with Postgres's own message. */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** Act as a signed-in user for subsequent queries. */
  asUser(uid: string): Promise<void>;
  /** Act as the service role (the seeder and admin actions). */
  asService(): Promise<void>;
  /** Act as an unauthenticated visitor. */
  asAnon(): Promise<void>;
  /** Drop back to superuser, for arranging fixtures. Bypasses RLS. */
  asSuperuser(): Promise<void>;
  /** Create an auth user and return its id. */
  createAuthUser(email: string): Promise<string>;
  /** Assert a query is rejected, and return the error message. */
  expectDenied(query: string, params?: unknown[]): Promise<string>;
  close(): Promise<void>;
}

export async function freshDb(): Promise<TestDb> {
  const pg = await PGlite.create();

  await pg.exec(AUTH_SHIM);
  // One exec() call per file, not one call for the concatenated lot: each
  // call is its own implicit transaction, which is what lets 0002's
  // `ALTER TYPE ... ADD VALUE` commit before 0003's `execute_trade` (which
  // references those values) is created — Postgres forbids using a new enum
  // value inside the same transaction that added it.
  for (const file of MIGRATIONS) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  await pg.exec(GRANTS);

  const db: TestDb = {
    async sql<T>(query: string, params?: unknown[]) {
      const res = await pg.query<T>(query, params as never[]);
      return res.rows;
    },

    async asUser(uid: string) {
      // Order matters: the GUC is set as superuser, then the role is assumed.
      await pg.exec("reset role");
      await pg.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ sub: uid, role: "authenticated" }),
      ]);
      await pg.exec("set role authenticated");
    },

    async asService() {
      await pg.exec("reset role");
      await pg.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      await pg.exec("set role service_role");
    },

    async asAnon() {
      await pg.exec("reset role");
      await pg.query("select set_config('request.jwt.claims', $1, false)", [""]);
      await pg.exec("set role anon");
    },

    async asSuperuser() {
      await pg.exec("reset role");
      await pg.query("select set_config('request.jwt.claims', $1, false)", [""]);
    },

    async createAuthUser(email: string) {
      // Creating the auth user needs superuser rights, so the caller's role is
      // saved and restored around it — a test mid-scenario should not silently
      // find itself acting as somebody else afterwards.
      const before = await pg.query<{ current_role: string }>("select current_role");
      const previous = before.rows[0]?.current_role;

      await pg.exec("reset role");
      const inserted = await pg.query<{ id: string }>(
        "insert into auth.users (email) values ($1) returning id",
        [email],
      );

      if (previous && previous !== "postgres") await pg.exec(`set role ${previous}`);
      return inserted.rows[0]!.id;
    },

    async expectDenied(query: string, params?: unknown[]) {
      try {
        await pg.query(query, params as never[]);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error(`Expected this to be denied, but it succeeded:\n  ${query}`);
    },

    async close() {
      await pg.close();
    },
  };

  return db;
}

/**
 * A signed-up player: auth user, profile, funded portfolio, public-league
 * membership — created the way the app creates them, through bootstrap_new_user.
 */
export async function signUp(db: TestDb, username: string) {
  const uid = await db.createAuthUser(`${username}@test.local`);
  await db.asUser(uid);
  const rows = await db.sql<{ bootstrap_new_user: string }>(
    "select bootstrap_new_user($1)",
    [username],
  );
  return { uid, portfolioId: rows[0]!.bootstrap_new_user };
}

/** An active season with a public league, as the seeder would create. */
export async function seedSeason(db: TestDb) {
  await db.asSuperuser();
  const season = await db.sql<{ id: string }>(
    `insert into seasons (name, slug, starting_balance, is_active)
     values ('Test Season', 'test-season', 100000, true) returning id`,
  );
  const seasonId = season[0]!.id;
  const league = await db.sql<{ id: string }>(
    `insert into leagues (season_id, name, code, is_public)
     values ($1, 'Public', 'SEASON1', true) returning id`,
    [seasonId],
  );
  await db.sql(
    `insert into price_cache (symbol, name, price, prev_close)
     values ('AAPL','Apple',200,198), ('MSFT','Microsoft',400,396), ('SPY','S&P 500 ETF',500,499)`,
  );
  return { seasonId, publicLeagueId: league[0]!.id };
}
