import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import postgres from "postgres";
import { z } from "zod";

const stagingProjectRef = "csmrsgywdosnrcfmnmuj";
const minimumResearchSearchUnits = 7;
const localDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const targetSchema = z.enum(["local", "staging"]);
const nonEmptyLineSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n]/.test(value));
const manifestSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.uuid(),
    model: nonEmptyLineSchema,
    rate: z.object({
      id: z.uuid(),
      provider: z.literal("workers-ai"),
      inputMicroUsdPerMillionTokens: z.number().int().nonnegative().safe(),
      outputMicroUsdPerMillionTokens: z.number().int().nonnegative().safe(),
    }),
    assistant: z.object({ id: z.uuid(), limitMicroUsd: z.number().int().positive().safe() }),
    research: z.object({ id: z.uuid(), limitMicroUsd: z.number().int().positive().safe() }),
    researchSearchUnitBound: z.number().int().min(minimumResearchSearchUnits).safe(),
    firecrawl: z
      .object({ id: z.uuid(), limitUnits: z.number().int().positive().safe() })
      .optional(),
  })
  .refine((manifest) => manifest.assistant.id !== manifest.research.id, {
    path: ["research", "id"],
    message: "Assistant and research allowance IDs must be different.",
  })
  .refine(
    (manifest) =>
      !manifest.firecrawl || manifest.firecrawl.limitUnits >= manifest.researchSearchUnitBound,
    {
      path: ["firecrawl", "limitUnits"],
      message: "Firecrawl allowance must cover the configured per-operation unit bound.",
    },
  );

type Target = z.infer<typeof targetSchema>;
type Manifest = z.infer<typeof manifestSchema>;

export function parseAdminArguments(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      target: { type: "string" },
      workspace: { type: "string" },
      manifest: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1 || !["status", "configure"].includes(positionals[0]!)) {
    throw new Error(
      "Usage: bun scripts/admin.ts <status|configure> --target <local|staging> --workspace <uuid> [--manifest <file>] [--apply]",
    );
  }
  if (!values.target || !values.workspace) {
    throw new Error("--target and --workspace are required.");
  }
  const target = targetSchema.parse(values.target);
  const workspaceId = z.uuid().parse(values.workspace);
  if (positionals[0] === "configure" && !values.manifest) {
    throw new Error("configure requires --manifest with explicitly approved rates and limits.");
  }
  return {
    command: positionals[0] as "status" | "configure",
    target,
    workspaceId,
    manifestPath: values.manifest,
    apply: values.apply,
  };
}

export function validateStagingDatabaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("STAGING_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/postgres") {
    throw new Error(
      "Staging database URL must use the PostgreSQL protocol and /postgres database.",
    );
  }
  const directHost = `db.${stagingProjectRef}.supabase.co`;
  const poolerHost = "aws-2-us-east-1.pooler.supabase.com";
  const validDirect = url.hostname === directHost && url.port === "5432";
  const validPooler =
    url.hostname === poolerHost &&
    url.port === "5432" &&
    decodeURIComponent(url.username) === `postgres.${stagingProjectRef}`;
  if (!validDirect && !validPooler) {
    throw new Error(
      `Staging database must use the configured project's direct host or verified session pooler (${stagingProjectRef}); refusing target.`,
    );
  }
  return value;
}

function databaseUrl(target: Target) {
  if (target === "local") return localDatabaseUrl;
  const value = process.env.STAGING_DATABASE_URL;
  if (!value)
    throw new Error(
      "Set STAGING_DATABASE_URL in the environment; do not pass credentials as arguments.",
    );
  return validateStagingDatabaseUrl(value);
}

export function validateManifest(input: unknown, workspaceId: string): Manifest {
  const manifest = manifestSchema.parse(input);
  if (manifest.workspaceId !== workspaceId) {
    throw new Error("Manifest workspaceId must exactly match --workspace.");
  }
  return manifest;
}

async function loadManifest(path: string, workspaceId: string): Promise<Manifest> {
  return validateManifest(JSON.parse(await readFile(path, "utf8")), workspaceId);
}

async function status(client: ReturnType<typeof postgres>, workspaceId: string) {
  const workspaces = await client`
    select id, name from workspaces where id = ${workspaceId}
  `;
  if (!workspaces.length) throw new Error(`Workspace ${workspaceId} does not exist.`);
  const [rates, inference, services] = await Promise.all([
    client`select id, provider, model, currency, input_micro_usd_per_million_tokens, output_micro_usd_per_million_tokens, created_at
      from inference_rates order by created_at, id`,
    client`select id, rate_version_id, limit_micro_usd, reserved_micro_usd, settled_micro_usd, approved_at, revoked_at
      from inference_budgets where workspace_id = ${workspaceId} order by id`,
    client`select provider, id, limit_units, reserved_units, settled_units, approved_at, revoked_at
      from service_budgets where workspace_id = ${workspaceId} order by provider, id`,
  ]);
  console.log(
    JSON.stringify(
      {
        workspace: workspaces[0],
        rates,
        inferenceAllowances: inference,
        serviceAllowances: services,
      },
      null,
      2,
    ),
  );
}

async function configure(client: ReturnType<typeof postgres>, manifest: Manifest, apply: boolean) {
  const operations = [
    `Create immutable rate ${manifest.rate.id} for ${manifest.model} at ${manifest.rate.inputMicroUsdPerMillionTokens}/${manifest.rate.outputMicroUsdPerMillionTokens} micro-USD per million tokens.`,
    `Create assistant inference allowance ${manifest.assistant.id}: ${manifest.assistant.limitMicroUsd} micro-USD.`,
    `Create research inference allowance ${manifest.research.id}: ${manifest.research.limitMicroUsd} micro-USD.`,
    ...(manifest.firecrawl
      ? [
          `Create Firecrawl service allowance ${manifest.firecrawl.id}: ${manifest.firecrawl.limitUnits} units.`,
        ]
      : [
          "No Firecrawl service allowance; research is configured for supplied-URL inference only.",
        ]),
  ];
  console.log(
    `${apply ? "APPLY" : "DRY RUN"}\n${operations.map((operation) => `- ${operation}`).join("\n")}`,
  );
  if (!apply) {
    printEnvironment(manifest);
    return;
  }

  await client.begin(async (tx) => {
    await tx`
      insert into inference_rates (id, provider, model, currency, input_micro_usd_per_million_tokens, output_micro_usd_per_million_tokens)
      values (${manifest.rate.id}, ${manifest.rate.provider}, ${manifest.model}, 'USD',
        ${manifest.rate.inputMicroUsdPerMillionTokens}, ${manifest.rate.outputMicroUsdPerMillionTokens})
      on conflict (id) do nothing
    `;
    const [rate] = await tx`select * from inference_rates where id = ${manifest.rate.id}`;
    if (
      !rate ||
      rate.currency !== "USD" ||
      rate.provider !== manifest.rate.provider ||
      rate.model !== manifest.model ||
      Number(rate.input_micro_usd_per_million_tokens) !==
        manifest.rate.inputMicroUsdPerMillionTokens ||
      Number(rate.output_micro_usd_per_million_tokens) !==
        manifest.rate.outputMicroUsdPerMillionTokens
    ) {
      throw new Error("Existing rate ID has different terms; immutable rate was not changed.");
    }

    for (const allowance of [manifest.assistant, manifest.research]) {
      await tx`
        insert into inference_budgets (workspace_id, id, rate_version_id, limit_micro_usd, approved_at)
        values (${manifest.workspaceId}, ${allowance.id}, ${manifest.rate.id}, ${allowance.limitMicroUsd}, now())
        on conflict (workspace_id, id) do nothing
      `;
      const [row] = await tx`
        select rate_version_id, limit_micro_usd, approved_at, revoked_at from inference_budgets
        where workspace_id = ${manifest.workspaceId} and id = ${allowance.id}
      `;
      if (
        !row ||
        row.rate_version_id !== manifest.rate.id ||
        Number(row.limit_micro_usd) !== allowance.limitMicroUsd ||
        !row.approved_at ||
        row.revoked_at
      ) {
        throw new Error(
          `Existing inference allowance ${allowance.id} differs or is revoked; refusing to refill or replace it.`,
        );
      }
    }

    if (manifest.firecrawl) {
      await tx`
        insert into service_budgets (workspace_id, provider, id, limit_units, approved_at)
        values (${manifest.workspaceId}, 'firecrawl', ${manifest.firecrawl.id}, ${manifest.firecrawl.limitUnits}, now())
        on conflict (workspace_id, provider, id) do nothing
      `;
      const [service] = await tx`
        select limit_units, approved_at, revoked_at from service_budgets
        where workspace_id = ${manifest.workspaceId} and provider = 'firecrawl' and id = ${manifest.firecrawl.id}
      `;
      if (
        !service ||
        Number(service.limit_units) !== manifest.firecrawl.limitUnits ||
        !service.approved_at ||
        service.revoked_at
      ) {
        throw new Error(
          `Existing Firecrawl allowance ${manifest.firecrawl.id} differs or is revoked; refusing to refill or replace it.`,
        );
      }
    }
  });
  printEnvironment(manifest);
}

function printEnvironment(manifest: Manifest) {
  console.log(`
Non-secret Worker configuration (review before enabling):
ASSISTANT_ENABLED=true
ASSISTANT_MODEL=${manifest.model}
ASSISTANT_BUDGET_ID=${manifest.assistant.id}
ASSISTANT_RATE_VERSION_ID=${manifest.rate.id}
RESEARCH_ENABLED=true
RESEARCH_MODEL=${manifest.model}
RESEARCH_BUDGET_ID=${manifest.research.id}
RESEARCH_RATE_VERSION_ID=${manifest.rate.id}
RESEARCH_DISCOVERY_ENABLED=${manifest.firecrawl ? "true" : "false"}${
    manifest.firecrawl
      ? `
RESEARCH_SERVICE_BUDGET_ID=${manifest.firecrawl.id}
RESEARCH_SEARCH_UNIT_BOUND=${manifest.researchSearchUnitBound}`
      : ""
  }
`);
}

async function main() {
  const options = parseAdminArguments(process.argv.slice(2));
  const client = postgres(databaseUrl(options.target), { max: 1, onnotice: () => {} });
  try {
    const [workspace] = await client`select id from workspaces where id = ${options.workspaceId}`;
    if (!workspace)
      throw new Error(
        `Workspace ${options.workspaceId} does not exist in the ${options.target} database.`,
      );
    if (options.command === "status") {
      await status(client, options.workspaceId);
      console.log(
        `\nDatabase records inspected only; Worker environment readiness was not checked. Provider keys are not read or printed.`,
      );
    } else {
      const manifest = await loadManifest(options.manifestPath!, options.workspaceId);
      await configure(client, manifest, options.apply);
      console.log("\nUsage receipts and existing reservations are retained.");
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Admin command failed.");
    process.exitCode = 1;
  }
}
