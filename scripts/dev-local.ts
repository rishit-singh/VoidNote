import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";
import { summaryBudgetPricing, summaryPolicy, summaryReservationMicroUsd } from "../src/ai/runtime";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const variablesFile = new URL("../.dev.vars.development", import.meta.url);
const network = "voidnote-dev";
const defaultAppOrigin = "http://localhost:8787";
const statusSchema = z.object({
  API_URL: z.url(),
  DB_URL: z.url(),
  ANON_KEY: z.string().optional(),
  PUBLISHABLE_KEY: z.string().optional(),
});

function applicationOrigin(value: unknown) {
  const origin = z.url().parse(value);
  const app = new URL(origin);
  if (origin !== app.origin || (app.protocol !== "https:" && origin !== defaultAppOrigin)) {
    throw new Error("APP_URL must be http://localhost:8787 or the exact HTTPS tunnel origin.");
  }
  return origin;
}

async function supabaseEnvironment() {
  let origin = defaultAppOrigin;
  try {
    const variables = parseEnv(await readFile(variablesFile, "utf8"));
    origin = applicationOrigin(variables.APP_URL);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return {
    ...process.env,
    VOIDNOTE_AUTH_SITE_URL: origin,
    VOIDNOTE_AUTH_CALLBACK_URL: `${origin}/auth/callback`,
  };
}

async function supabase(...args: string[]) {
  const env = await supabaseEnvironment();
  try {
    const result = await execute("bunx", ["--no-install", "supabase", ...args, "--agent", "no"], {
      cwd: root,
      env,
      timeout: 15 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    // CLI status/start output contains keys. Keep diagnostics in an ignored,
    // owner-readable file rather than printing credentials in a terminal.
    await mkdir(new URL("../.wrangler/", import.meta.url), { recursive: true });
    const log = new URL("../.wrangler/dev-supabase-error.log", import.meta.url);
    const output =
      error instanceof Error && "stderr" in error && "stdout" in error
        ? `${String(error.stdout)}\n${String(error.stderr)}`
        : "Could not start the Supabase CLI.";
    await writeFile(log, output, { mode: 0o600 });
    await chmod(log, 0o600);
    throw new Error("Supabase command failed. See .wrangler/dev-supabase-error.log.");
  }
}

async function localStatus() {
  const status = statusSchema.parse(JSON.parse(await supabase("status", "-o", "json")));
  const database = new URL(status.DB_URL);
  const api = new URL(status.API_URL);
  if (
    !["localhost", "127.0.0.1"].includes(database.hostname) ||
    database.port !== "54322" ||
    database.pathname !== "/postgres" ||
    !["localhost", "127.0.0.1"].includes(api.hostname) ||
    api.port !== "54321"
  ) {
    throw new Error("Expected the local Supabase instance configured in supabase/config.toml.");
  }
  const key = status.PUBLISHABLE_KEY || status.ANON_KEY;
  if (!key) throw new Error("Local Supabase did not return a publishable client key.");
  return { ...status, key };
}

async function prepareNetwork() {
  try {
    await execute("docker", ["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    throw new Error("Start Docker Desktop or OrbStack, then run bun run dev:setup again.");
  }
  const result = await execute("docker", ["network", "ls", "--format", "{{.Name}}"]);
  if (!result.stdout.split("\n").includes(network)) {
    await execute("docker", [
      "network",
      "create",
      "-o",
      "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
      network,
    ]);
  }
  const inspected = await execute("docker", [
    "network",
    "inspect",
    network,
    "--format",
    '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}',
  ]);
  if (inspected.stdout.trim() !== "127.0.0.1") {
    throw new Error("The voidnote-dev Docker network must bind published ports to 127.0.0.1.");
  }
}

async function readVariables(status: Awaited<ReturnType<typeof localStatus>>) {
  let source: string;
  try {
    source = await readFile(variablesFile, "utf8");
  } catch {
    throw new Error("Run bun run dev:setup to create .dev.vars.development.");
  }
  const variables = parseEnv(source);
  if (
    variables.SUPABASE_URL !== status.API_URL ||
    variables.SUPABASE_PUBLISHABLE_KEY !== status.key
  ) {
    throw new Error(
      "Local auth settings changed. Update SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .dev.vars.development from local Supabase status.",
    );
  }
  const origin = applicationOrigin(variables.APP_URL);
  const app = new URL(origin);
  if ((variables.RECORDING_CAPABILITY_SECRET?.length ?? 0) < 32) {
    throw new Error("RECORDING_CAPABILITY_SECRET must contain at least 32 characters.");
  }
  if (!["true", "false"].includes(variables.SUMMARY_ENABLED ?? "")) {
    throw new Error("Set SUMMARY_ENABLED explicitly to true or false.");
  }
  if (variables.SUMMARY_ENABLED === "true" && !variables.SUMMARY_MODEL?.trim()) {
    throw new Error("Select SUMMARY_MODEL before enabling paid development inference.");
  }
  if (variables.SUMMARY_ENABLED === "true") {
    const budgetId = z.uuid().parse(variables.SUMMARY_BUDGET_ID);
    summaryReservationMicroUsd(summaryPolicy(variables.SUMMARY_MODEL!, budgetId));
  }
  if (variables.PYANNOTE_API_KEY && app.protocol !== "https:") {
    throw new Error(
      "Real transcription requires an HTTPS tunnel APP_URL. See docs/local-development.md.",
    );
  }
  return variables;
}

async function setup() {
  await prepareNetwork();
  console.log("Starting local Supabase (first run downloads container images)...");
  await supabase("start", "--network-id", network);
  const status = await localStatus();
  const template = await readFile(new URL("../.dev.vars.example", import.meta.url), "utf8");
  const content = template
    .replace(/^SUPABASE_URL=.*$/m, `SUPABASE_URL=${status.API_URL}`)
    .replace(/^SUPABASE_PUBLISHABLE_KEY=.*$/m, `SUPABASE_PUBLISHABLE_KEY=${status.key}`)
    .replace(
      /^RECORDING_CAPABILITY_SECRET=.*$/m,
      `RECORDING_CAPABILITY_SECRET=${randomBytes(32).toString("hex")}`,
    );
  try {
    await writeFile(variablesFile, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await readVariables(status);
  // Never use an inherited DATABASE_URL: migrations target only this local stack.
  const client = postgres(status.DB_URL, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
  } finally {
    await client.end({ timeout: 5 });
  }
  console.log(
    "Local database migrated; existing data and .dev.vars.development preserved.\n" +
      "Mailpit: http://localhost:54324\nStudio: http://localhost:54323\n" +
      "Start the app: bun run dev:local",
  );
}

async function initializeSummaryBudget() {
  const budgetId = z.uuid().parse(process.argv[3]);
  const dollars = z.coerce.number().min(0.01).max(1000).multipleOf(0.01).parse(process.argv[4]);
  const limitMicroUsd = Math.round(dollars * 1_000_000);
  const model = summaryBudgetPricing.model;
  const reservationMicroUsd = summaryReservationMicroUsd(summaryPolicy(model, budgetId));
  const status = await localStatus();
  const client = postgres(status.DB_URL, { max: 1, onnotice: () => {} });
  try {
    const allowance = await client.begin(async (tx) => {
      await tx`
        insert into summary_inference_budgets
          (id, model, limit_micro_usd, reservation_micro_usd)
        values (${budgetId}, ${model}, ${limitMicroUsd}, ${reservationMicroUsd})
        on conflict (id) do nothing
      `;
      const [row] = await tx<
        {
          model: string;
          limit_micro_usd: number;
          reservation_micro_usd: number;
          reserved_micro_usd: number;
          settled_micro_usd: number;
        }[]
      >`select model, limit_micro_usd, reservation_micro_usd, reserved_micro_usd, settled_micro_usd
          from summary_inference_budgets where id = ${budgetId}`;
      if (
        !row ||
        row.model !== model ||
        row.limit_micro_usd !== limitMicroUsd ||
        row.reservation_micro_usd !== reservationMicroUsd
      ) {
        throw new Error("Existing allowance differs. Its limits and reservations were not reset.");
      }
      return row;
    });
    console.log(
      `Summary allowance ${budgetId}: $${dollars.toFixed(2)} limit; ` +
        `$${(allowance.reserved_micro_usd / 1_000_000).toFixed(6)} held; ` +
        `$${(allowance.settled_micro_usd / 1_000_000).toFixed(6)} usage-accounted. ` +
        "Existing reservations retained.",
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    // OpenNext starts Wrangler through a shell. A process group makes Ctrl+C
    // and supervisor shutdown reach workerd as well as the immediate CLI.
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", detached: grouped });
    let cancelled: NodeJS.Signals | null = null;
    const stop = (signal: NodeJS.Signals) => {
      cancelled = signal;
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (cancelled || signal || code !== 0) {
        reject(new Error(`${command} stopped (${cancelled ?? signal ?? code}).`));
      } else {
        resolve();
      }
    });
  });
}

async function preview(build: boolean) {
  const version = await execute("node", ["-p", "process.versions.node"]);
  if (!version.stdout.startsWith("24."))
    throw new Error("Select Node 24 before starting the app (see .node-version).");
  const status = await localStatus();
  const variables = await readVariables(status);
  const app = new URL(variables.APP_URL!);
  const tunneled = app.protocol === "https:";
  const inferenceEnabled = [
    variables.SUMMARY_ENABLED,
    variables.ASSISTANT_ENABLED,
    variables.RESEARCH_ENABLED,
    variables.CONVERSATION_SUMMARY_ENABLED,
  ].some((value) => value === "true");
  const env = {
    ...process.env,
    NEXT_DEV_WRANGLER_ENV: "development",
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: status.DB_URL,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    // A public tunnel must not expose Wrangler's unauthenticated storage explorer.
    X_LOCAL_EXPLORER: tunneled ? "false" : (process.env.X_LOCAL_EXPLORER ?? "true"),
  };
  if (build) {
    await run(
      "bunx",
      ["--no-install", "opennextjs-cloudflare", "build", "--env", "development"],
      env,
    );
    await run("bun", ["scripts/prepare-worker-env.ts"], env);
  }
  console.log(
    `Open ${variables.APP_URL}; request a sign-in link and open it in Mailpit on this browser.`,
  );
  await run(
    "bunx",
    [
      "--no-install",
      "opennextjs-cloudflare",
      "preview",
      "--env",
      "development",
      "--ip",
      "127.0.0.1",
      "--port",
      "8787",
      "--inspector-port",
      "0",
      "--persist-to",
      ".wrangler/development",
      ...(tunneled
        ? ["--local-upstream", app.host, "--upstream-protocol", "https"]
        : ["--test-scheduled"]),
      ...(inferenceEnabled ? [] : ["--local"]),
    ],
    env,
  );
}

try {
  switch (process.argv[2] ?? "") {
    case "setup":
      await setup();
      break;
    case "start":
      await preview(true);
      break;
    case "preview":
      await preview(false);
      break;
    case "summary-budget":
      await initializeSummaryBudget();
      break;
    case "stop":
      await supabase("stop");
      console.log(
        "Supabase stopped; local data retained. Stop the app with Ctrl+C in its terminal.",
      );
      break;
    default:
      throw new Error("Use bun run dev:setup, dev:local, dev:preview or dev:stop.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local development command failed.");
  process.exitCode = 1;
}
