/**
 * One-command setup: checks the environment, applies the schema, seeds the season.
 *
 *   npm run setup
 *
 * Safe to re-run at any point — it works out which steps are already done and
 * only does what is left. The one thing it cannot do for you is create the
 * Supabase project and paste in the keys.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const ENV_FILE = join(root, ".env.local");
const MIGRATION = join(root, "supabase", "migrations", "0001_init.sql");

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function fail(message: string): never {
  console.error(`\n${red("✗")} ${message}\n`);
  process.exit(1);
}

/** Minimal .env parser — avoids a dependency for four lines of work. */
function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  // \r?\n, not just \n: a CRLF file otherwise leaves a trailing \r stuck to
  // every line but the last, which stops the $ anchor below from matching —
  // every var except the final line in the file would silently fail to load.
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function main() {
  console.log(`\n${bold("StockOff setup")}\n`);

  // ---- 1. environment -----------------------------------------------------
  if (!existsSync(ENV_FILE)) {
    fail(
      `No .env.local yet.\n\n` +
        `  1. Create a free project at ${bold("https://supabase.com")}\n` +
        `  2. cp .env.example .env.local\n` +
        `  3. From Supabase ${bold("Project Settings → API")}, paste in the project URL,\n` +
        `     the anon key and the service_role key.\n\n` +
        `  Then run this again.`,
    );
  }

  const env = readEnv(ENV_FILE);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;

  const placeholder = (v: string | undefined) =>
    !v || v.includes("your-") || v.includes("your_");

  if (placeholder(url) || placeholder(anon) || placeholder(service)) {
    const missing = [
      placeholder(url) && "NEXT_PUBLIC_SUPABASE_URL",
      placeholder(anon) && "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      placeholder(service) && "SUPABASE_SERVICE_ROLE_KEY",
    ].filter(Boolean);
    fail(
      `.env.local still has placeholder values for:\n\n` +
        missing.map((m) => `    ${m}`).join("\n") +
        `\n\n  Copy the real values from Supabase → Project Settings → API.`,
    );
  }
  console.log(`${green("✓")} .env.local looks filled in`);

  // ---- 2. schema ----------------------------------------------------------
  // Probe a table through the REST API. A 404 on the relation means the
  // migration has not been applied yet.
  const probe = await fetch(`${url}/rest/v1/seasons?select=id&limit=1`, {
    headers: { apikey: service!, Authorization: `Bearer ${service}` },
  }).catch((err: Error) => {
    fail(`Could not reach ${url}\n\n  ${err.message}\n\n  Is the project URL right?`);
  });

  if (probe.status === 401 || probe.status === 403) {
    fail("Supabase rejected the service_role key. Copy it again from Project Settings → API.");
  }

  if (!probe.ok) {
    const body = await probe.text();
    if (!/does not exist|relation|schema/i.test(body)) {
      fail(`Unexpected response from Supabase (${probe.status}):\n\n  ${body}`);
    }

    // Schema missing. Put the SQL on the clipboard so applying it is one paste.
    let copied = false;
    try {
      execFileSync("pbcopy", { input: readFileSync(MIGRATION) });
      copied = true;
    } catch {
      // Not macOS, or no pbcopy — fall back to telling them the path.
    }

    const ref = url!.match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
    const editor = ref
      ? `https://supabase.com/dashboard/project/${ref}/sql/new`
      : "your project's SQL Editor";

    console.log(`${dim("•")} schema not applied yet\n`);
    console.log(`  ${bold("Do this once:")}\n`);
    console.log(
      copied
        ? `  1. The migration is now on your clipboard.`
        : `  1. Copy the contents of supabase/migrations/0001_init.sql`,
    );
    console.log(`  2. Open ${bold(editor)}`);
    console.log(`  3. Paste, then press ${bold("Run")}.`);
    console.log(`\n  Then run ${bold("npm run setup")} again.\n`);
    process.exit(2);
  }
  console.log(`${green("✓")} schema is applied`);

  // ---- 3. seed ------------------------------------------------------------
  console.log(`${dim("•")} seeding the season…\n`);
  try {
    execFileSync("npx", ["tsx", join("scripts", "seed.ts")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
  } catch {
    fail("Seeding failed — see the output above.");
  }

  console.log(`\n${green("✓")} setup complete\n`);
  console.log(`  Start the app:  ${bold("npm run dev")}`);
  console.log(`  Then open:      ${bold("http://localhost:3000")}\n`);
  console.log(`  ${dim("Sign up for real to join StockOff League — no seeded accounts.")}\n`);
  console.log(
    `  ${dim("If signup gives an error, turn off Authentication → Providers →")}\n` +
      `  ${dim("Email → \"Confirm email\" in Supabase, which blocks the first session.")}\n`,
  );
}

main().catch((err) => {
  fail(err?.message ?? String(err));
});
