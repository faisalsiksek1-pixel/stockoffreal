import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Access-control checks.
 *
 * Authorisation lives in Postgres RLS and in server actions, neither of which can
 * be exercised without a live Supabase project. What is verifiable here — and
 * genuinely worth verifying, because these are the mistakes that leak data — is
 * that the source never drifts into an unsafe shape:
 *
 *   - every admin action gates on requireAdmin before touching the service role
 *   - the service-role key is never exposed to the browser
 *   - RLS is enabled on every table
 *   - users cannot write their own holdings or trades directly
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("admin actions", () => {
  const source = read("src/actions/admin.ts");

  it("checks admin rights in every exported action", () => {
    const exported = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(exported.length).toBeGreaterThan(3);

    for (const name of exported) {
      const start = source.indexOf(`export async function ${name}`);
      const body = source.slice(start, start + 700);
      expect(body, `${name} must call requireAdmin first`).toMatch(/requireAdmin\(\)/);
    }
  });

  it("verifies the caller before constructing the service-role client", () => {
    for (const name of ["adminTrade", "adminResetBalances", "adminRenameUser"]) {
      const body = source.slice(source.indexOf(`export async function ${name}`));
      const guard = body.indexOf("requireAdmin()");
      const escalate = body.indexOf("createAdminClient()");
      expect(guard).toBeGreaterThan(-1);
      expect(escalate).toBeGreaterThan(guard);
    }
  });

  it("reads is_admin from the database rather than trusting client input", () => {
    expect(source).toMatch(/from\("profiles"\)[\s\S]{0,80}is_admin/);
  });
});

describe("secret handling", () => {
  it("never exposes the service-role key to the browser", () => {
    // A NEXT_PUBLIC_ prefix would ship the key in the client bundle.
    expect(read("src/lib/supabase/server.ts")).not.toMatch(
      /NEXT_PUBLIC_SUPABASE_SERVICE/,
    );
    expect(read(".env.example")).not.toMatch(/NEXT_PUBLIC_.*SERVICE_ROLE/);
  });

  it("keeps the service-role client out of client components", () => {
    const client = read("src/lib/supabase/client.ts");
    expect(client).not.toMatch(/SERVICE_ROLE/);
    expect(client).toMatch(/createBrowserClient/);
  });

  it("keeps the market-data API key server-side only", () => {
    expect(read("src/lib/market/finnhub.ts")).not.toMatch(/NEXT_PUBLIC/);
  });
});

describe("row level security", () => {
  const sql = read("supabase/migrations/0001_init.sql");
  // league_members was dropped in 0004_competitions.sql — portfolios.league_id
  // replaces it, so a portfolio row now *is* a (user, competition) membership.
  const competitionsSql = read("supabase/migrations/0004_competitions.sql");

  it("enables RLS on every table", () => {
    const tables = [
      "seasons", "profiles", "portfolios", "holdings",
      "trades", "leagues", "price_cache",
    ];
    for (const t of tables) {
      expect(sql, `RLS missing on ${t}`).toMatch(
        new RegExp(`alter table ${t}\\s+enable row level security`),
      );
    }
  });

  it("grants users no direct write access to portfolios, holdings or trades", () => {
    // All position and cash changes must go through execute_trade, which enforces
    // the rules. Note portfolios is in this list: RLS cannot restrict an UPDATE to
    // one column, so *any* user update policy on portfolios would also permit
    // `set cash = 99999999` from the browser with the public anon key.
    for (const table of ["portfolios", "holdings", "trades"]) {
      const policies = [...sql.matchAll(/create policy "([^"]+)" on (\w+)\s+for (\w+)/g)]
        .filter((m) => m[2] === table)
        .map((m) => ({ name: m[1]!, op: m[3]! }));

      const userWrites = policies.filter(
        (p) => p.op !== "select" && !p.name.startsWith("admin"),
      );
      expect(userWrites, `${table} should have no user write policy`).toHaveLength(0);
    }
  });

  it("creates a competition portfolio only through a security-definer function, never a write policy", () => {
    // Users still have no insert policy on portfolios (covered above) — the
    // one way to get a portfolio in a competition is create_portfolio_in_league,
    // which must therefore do its own ownership check the way execute_trade
    // does, since definer rights bypass RLS entirely.
    const fn = competitionsSql.slice(
      competitionsSql.indexOf("function create_portfolio_in_league"),
    );
    expect(fn).toMatch(/security definer/);
    expect(fn).toMatch(/set search_path = public/);
    expect(fn).toMatch(/cannot create a portfolio for another user/i);
  });

  it("does not publish private league invite codes", () => {
    // `using (true)` on leagues would hand every private code to any caller.
    // The effective policy now lives in 0004_competitions.sql, which
    // repoints it at portfolios instead of the dropped league_members table.
    const start = competitionsSql.indexOf('create policy "leagues readable"');
    const policy = competitionsSql.slice(start, start + 400);
    expect(policy).not.toMatch(/using \(true\)/);
    expect(policy).toMatch(/is_public/);
    expect(policy).toMatch(/profile_id = auth\.uid\(\)/);
  });

  it("locks the portfolio row inside the trade function", () => {
    // Without FOR UPDATE, two concurrent trades could both pass the cash check.
    const fn = sql.slice(sql.indexOf("function execute_trade"));
    expect(fn).toMatch(/for update/i);
    expect(fn).toMatch(/Not enough cash/);
    expect(fn).toMatch(/You only own/);
  });

  it("checks portfolio ownership inside execute_trade, before any write", () => {
    // execute_trade must be SECURITY DEFINER (users hold no write policy on
    // holdings/trades, so invoker rights would be denied by RLS on its own
    // inserts) — which means it has to do the ownership check RLS would have done.
    //
    // Asserted on the raise, not on the comparison expression: an earlier version
    // of this test grepped for the literal `v_owner = auth.uid()` and broke the
    // moment that line was rewritten to close a NULL hole — failing on a change
    // that made the code safer. What ownership actually *does* is covered
    // behaviourally in schema.test.ts against a live Postgres.
    const fn = sql.slice(
      sql.indexOf("function execute_trade"),
      sql.indexOf("function bootstrap_new_user"),
    );
    expect(fn).toMatch(/security definer/);
    expect(fn).toMatch(/set search_path = public/);

    const guard = fn.indexOf("not your portfolio");
    const write = fn.indexOf("update portfolios set cash");
    expect(guard, "ownership must be checked").toBeGreaterThan(-1);
    expect(write, "and checked before any write").toBeGreaterThan(guard);
  });

  it("keeps definer functions from being hijacked by search_path", () => {
    const definers = [...sql.matchAll(/function (\w+)\(/g)].map((m) => m[1]!);
    for (const name of ["bootstrap_new_user", "join_league_by_code", "is_admin", "league_preview"]) {
      expect(definers).toContain(name);
      const fn = sql.slice(sql.indexOf(`function ${name}(`));
      const head = fn.slice(0, fn.indexOf("$$"));
      expect(head, `${name} must pin search_path`).toMatch(/set search_path = public/);
    }
  });
});

describe("limit orders (0007_pending_orders.sql)", () => {
  const sql = read("supabase/migrations/0007_pending_orders.sql");

  it("enables RLS with no user write policy", () => {
    expect(sql).toMatch(/alter table pending_orders\s+enable row level security/);

    const policies = [...sql.matchAll(/create policy "([^"]+)" on (\w+)\s+for (\w+)/g)]
      .filter((m) => m[2] === "pending_orders")
      .map((m) => ({ name: m[1]!, op: m[3]! }));
    const userWrites = policies.filter((p) => p.op !== "select");
    expect(userWrites, "pending_orders should have no user write policy").toHaveLength(0);
  });

  it("checks ownership and pins search_path in every definer function", () => {
    for (const name of ["place_limit_order", "cancel_limit_order", "fill_pending_order"]) {
      const fn = sql.slice(sql.indexOf(`function ${name}(`));
      const head = fn.slice(0, fn.indexOf("$$"));
      expect(head, `${name} must be security definer`).toMatch(/security definer/);
      expect(head, `${name} must pin search_path`).toMatch(/set search_path = public/);
      expect(fn, `${name} must check ownership`).toMatch(/not your (portfolio|order)/);
    }
  });

  it("re-validates the price crossing inside fill_pending_order, not just at placement", () => {
    const fn = sql.slice(sql.indexOf("function fill_pending_order"));
    expect(fn).toMatch(/p_price > v_target/);
    expect(fn).toMatch(/p_price < v_target/);
  });
});

describe("google sign-in", () => {
  const auth = read("src/actions/auth.ts");
  const callback = read("src/app/auth/callback/route.ts");
  const middleware = read("src/middleware.ts");

  it("only ever redirects to relative paths after sign-in", () => {
    // An unchecked ?next= is an open redirect: a crafted link could bounce
    // someone to an attacker's page carrying a fresh session.
    for (const [name, source] of [
      ["signInWithGoogle", auth],
      ["callback route", callback],
    ] as const) {
      expect(source, `${name} must reject absolute next targets`).toMatch(
        /startsWith\("\/"\)[\s\S]{0,60}!.*startsWith\("\/\/"\)/,
      );
    }
  });

  it("guards /welcome behind a session", () => {
    expect(middleware).toContain('"/welcome"');
  });

  it("never sends a profile-less session to /signup", () => {
    // Middleware bounces signed-in users off /signup, so redirecting there when a
    // session exists without a profile is an infinite loop. Google sign-in makes
    // that state reachable, so every such redirect must target /welcome.
    for (const file of [
      "src/app/(app)/layout.tsx",
      "src/app/(app)/dashboard/page.tsx",
      "src/app/(app)/trade/page.tsx",
      "src/app/(app)/portfolio/page.tsx",
      "src/app/(app)/profile/page.tsx",
      "src/app/(app)/share/page.tsx",
    ]) {
      const source = read(file);
      expect(source, `${file} would loop`).not.toMatch(/redirect\("\/signup"\)/);
      expect(source).toMatch(/redirect\("\/welcome"\)/);
    }
  });

  it("re-validates the username server-side rather than trusting the form", () => {
    const body = auth.slice(auth.indexOf("export async function completeProfile"));
    expect(body).toMatch(/UsernameSchema\.safeParse/);
    expect(body).toMatch(/getUser\(\)/);
    // Uniqueness is checked before bootstrapping, not left to a constraint error.
    const check = body.indexOf("ilike");
    const bootstrap = body.indexOf("bootstrap_new_user");
    expect(check).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(check);
  });

  it("exchanges the code in a route handler, not a page", () => {
    // Server Components cannot set cookies, so the exchange has to happen here.
    expect(callback).toMatch(/exchangeCodeForSession/);
    expect(callback).toMatch(/export async function GET/);
  });

  it("treats a cancelled consent screen as a non-error", () => {
    expect(callback).toMatch(/searchParams\.get\("error"\)/);
  });
});

describe("rpc contract", () => {
  // PostgREST binds RPC arguments by exact name, so a renamed SQL parameter is a
  // runtime failure with no compile-time signal. This is the one seam the live
  // Postgres tests cannot cover, because they call the functions directly rather
  // than through PostgREST.
  //
  // Reads every migration file, not just 0001 — a function redefined in a
  // later migration (e.g. bootstrap_new_user in 0004_competitions.sql, or a
  // brand new one like create_portfolio_in_league) needs its current
  // signature checked, not its original one. Concatenating in file order and
  // building the Map from that array is safe: a later `create or replace`
  // overwrites the earlier entry for the same function name, exactly
  // matching what Postgres itself does.
  const migrationsDir = join(root, "supabase", "migrations");
  const sql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n");

  const sqlSignatures = new Map<string, string[]>(
    [...sql.matchAll(/create or replace function (\w+)\(([^)]*)\)/g)].map((m) => [
      m[1]!,
      [...m[2]!.matchAll(/(p_\w+)/g)].map((p) => p[1]!),
    ]),
  );

  const callSites = ["src/actions/trade.ts", "src/actions/orders.ts", "src/lib/orders.ts", "src/lib/notifications.ts", "src/lib/snapshots.ts", "src/actions/auth.ts", "src/actions/leagues.ts", "src/actions/admin.ts", "src/actions/chat.ts", "src/app/(app)/leagues/[code]/page.tsx", "scripts/seed.ts"];

  it("calls only functions that exist, with argument names that exist", () => {
    let checked = 0;

    for (const file of callSites) {
      const source = read(file);
      for (const call of source.matchAll(/\.rpc\("(\w+)",\s*\{([^}]*)\}/g)) {
        const name = call[1]!;
        const args = [...call[2]!.matchAll(/(p_\w+)\s*:/g)].map((a) => a[1]!);

        const expected = sqlSignatures.get(name);
        expect(expected, `${file} calls unknown function ${name}`).toBeDefined();

        for (const arg of args) {
          expect(expected, `${name} has no parameter ${arg} (called in ${file})`).toContain(arg);
        }
        checked++;
      }
    }

    // Guard against the regexes silently matching nothing.
    expect(checked).toBeGreaterThanOrEqual(5);
    expect(sqlSignatures.get("execute_trade")).toEqual([
      "p_portfolio_id", "p_symbol", "p_side", "p_shares", "p_price", "p_leverage",
    ]);
  });

  it("supplies every required argument of execute_trade at each call site", () => {
    const required = sqlSignatures.get("execute_trade")!;
    for (const file of ["src/actions/trade.ts", "src/actions/admin.ts", "scripts/seed.ts"]) {
      const source = read(file);
      const call = source.match(/\.rpc\("execute_trade",\s*\{([^}]*)\}/);
      expect(call, `${file} should call execute_trade`).not.toBeNull();
      const args = [...call![1]!.matchAll(/(p_\w+)\s*:/g)].map((a) => a[1]!);
      expect(args.sort()).toEqual([...required].sort());
    }
  });
});

describe("route protection", () => {
  const middleware = read("src/middleware.ts");

  it("guards every private route prefix", () => {
    for (const route of ["/dashboard", "/trade", "/portfolio", "/leagues", "/profile", "/admin"]) {
      expect(middleware).toContain(`"${route}"`);
    }
  });

  it("redirects unauthenticated requests to login", () => {
    // Assert on the shape of the guard block rather than a character distance:
    // the branch taken when there is no user must send them to /login.
    const guard = middleware.indexOf("!user &&");
    expect(guard).toBeGreaterThan(-1);

    const block = middleware.slice(guard, middleware.indexOf("}", guard + 200));
    expect(block).toMatch(/pathname = "\/login"/);
    expect(block).toMatch(/NextResponse\.redirect/);
  });

  it("preserves the intended destination so login returns the user to it", () => {
    expect(middleware).toMatch(/searchParams\.set\("next"/);
  });

  it("re-checks admin rights on the admin page itself", () => {
    const page = read("src/app/admin/page.tsx");
    expect(page).toMatch(/is_admin/);
    expect(page).toMatch(/redirect\("\/dashboard"\)/);
  });
});
