import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { parseEnv } from "node:util";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";

import { summaryPolicy, summaryReservationMicroUsd } from "../src/ai/runtime";

// Explicit November 25 authorization: a NEW $2.50 local application allowance.
// This operation never refills existing allowances or touches the proof database.
const directory = new URL("../.wrangler/live-demo-2026-11-25/", import.meta.url);
const variablesFile = new URL("../.dev.vars.development", import.meta.url);
const model = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const origin = z.url().parse(process.argv[2]);
assert.equal(new URL(origin).origin, origin);
assert.equal(new URL(origin).protocol, "https:");
const manifestSchema = z.object({
  version: z.literal(1),
  workspaceId: z.uuid(),
  rateVersionId: z.uuid(),
  chatBudgetId: z.uuid(),
  researchBudgetId: z.uuid(),
  conversationBudgetId: z.uuid(),
  summaryBudgetId: z.uuid(),
});
const client = postgres("postgresql://postgres:postgres@127.0.0.1:54322/postgres", {
  max: 1,
  onnotice: () => {},
});

try {
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  const owners = await client<{ workspace_id: string }[]>`
    select m.workspace_id from workspace_memberships m
    join auth.users u on u.id = m.user_id
    where u.email = 'dev@example.com' and m.role = 'owner'
  `;
  assert.equal(owners.length, 1, "Expected one existing dev@example.com workspace.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestFile = new URL("manifest.json", directory);
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    manifest = manifestSchema.parse({
      version: 1,
      workspaceId: owners[0]!.workspace_id,
      rateVersionId: randomUUID(),
      chatBudgetId: randomUUID(),
      researchBudgetId: randomUUID(),
      conversationBudgetId: randomUUID(),
      summaryBudgetId: randomUUID(),
    });
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  assert.equal(manifest.workspaceId, owners[0]!.workspace_id);
  await client.begin(async (tx) => {
    await tx`
      insert into inference_rates
        (id,provider,model,currency,input_micro_usd_per_million_tokens,output_micro_usd_per_million_tokens)
      values (${manifest.rateVersionId},'workers-ai',${model},'USD',300000,1200000)
      on conflict (id) do nothing
    `;
    const [rate] = await tx`select * from inference_rates where id=${manifest.rateVersionId}`;
    assert.equal(rate!.model, model);
    assert.equal(rate!.provider, "workers-ai");
    assert.equal(rate!.currency, "USD");
    assert.equal(Number(rate!.input_micro_usd_per_million_tokens), 300_000);
    assert.equal(Number(rate!.output_micro_usd_per_million_tokens), 1_200_000);
    for (const [id, limit] of [
      [manifest.chatBudgetId, 1_000_000],
      [manifest.researchBudgetId, 500_000],
      [manifest.conversationBudgetId, 500_000],
    ] as const) {
      await tx`
        insert into inference_budgets (workspace_id,id,rate_version_id,limit_micro_usd,approved_at)
        values (${manifest.workspaceId},${id},${manifest.rateVersionId},${limit},now())
        on conflict (workspace_id,id) do nothing
      `;
      const [budget] = await tx`
        select * from inference_budgets where workspace_id=${manifest.workspaceId} and id=${id}
      `;
      assert.equal(budget!.rate_version_id, manifest.rateVersionId);
      assert.equal(Number(budget!.limit_micro_usd), limit);
      assert.ok(budget!.approved_at && !budget!.revoked_at);
    }
    const reservation = summaryReservationMicroUsd(summaryPolicy(model, manifest.summaryBudgetId));
    await tx`
      insert into summary_inference_budgets (id,model,limit_micro_usd,reservation_micro_usd)
      values (${manifest.summaryBudgetId},${model},500000,${reservation})
      on conflict (id) do nothing
    `;
    const [summary] = await tx`
      select * from summary_inference_budgets where id=${manifest.summaryBudgetId}
    `;
    assert.equal(summary!.model, model);
    assert.equal(Number(summary!.limit_micro_usd), 500_000);
    assert.equal(Number(summary!.reservation_micro_usd), reservation);
  });

  const source = await readFile(variablesFile, "utf8");
  const variables = parseEnv(source);
  assert.equal(variables.SUPABASE_URL, "http://127.0.0.1:54321");
  const backup = new URL("development-vars.before-demo", directory);
  try {
    await copyFile(variablesFile, backup, 1);
    await chmod(backup, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const selected: Record<string, string> = {
    APP_URL: origin,
    SUMMARY_ENABLED: "true",
    SUMMARY_MODEL: model,
    SUMMARY_BUDGET_ID: manifest.summaryBudgetId,
    SUMMARY_REASONING_EFFORT: "low",
    ASSISTANT_ENABLED: "true",
    ASSISTANT_MODEL: model,
    ASSISTANT_BUDGET_ID: manifest.chatBudgetId,
    ASSISTANT_RATE_VERSION_ID: manifest.rateVersionId,
    RESEARCH_ENABLED: "true",
    RESEARCH_MODEL: model,
    RESEARCH_BUDGET_ID: manifest.researchBudgetId,
    RESEARCH_RATE_VERSION_ID: manifest.rateVersionId,
    CONVERSATION_SUMMARY_ENABLED: "true",
    CONVERSATION_SUMMARY_MODEL: model,
    CONVERSATION_SUMMARY_BUDGET_ID: manifest.conversationBudgetId,
    CONVERSATION_SUMMARY_RATE_VERSION_ID: manifest.rateVersionId,
  };
  let updated = source;
  for (const [key, value] of Object.entries(selected)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    updated = pattern.test(updated)
      ? updated.replace(pattern, `${key}=${value}`)
      : `${updated.trimEnd()}\n${key}=${value}\n`;
  }
  await writeFile(variablesFile, updated, { mode: 0o600 });
  await chmod(variablesFile, 0o600);
  console.log(
    "Local migrations applied; fixed $2.50 demo allowances selected; existing data and holds retained.",
  );
  console.log(`App origin: ${origin}. Restart local Supabase Auth and the development Worker.`);
} finally {
  await client.end({ timeout: 5 });
}
