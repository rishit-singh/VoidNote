import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAdminArguments,
  validateManifest,
  validateStagingDatabaseUrl,
} from "../../scripts/admin";

const workspaceId = "094563d2-f5ad-4a0f-ad8e-c9a9a5d4f533";
const manifest = {
  version: 1,
  workspaceId,
  model: "@cf/example/model",
  rate: {
    id: "11000000-0000-4000-8000-000000000001",
    provider: "workers-ai",
    inputMicroUsdPerMillionTokens: 300_000,
    outputMicroUsdPerMillionTokens: 1_200_000,
  },
  assistant: { id: "11000000-0000-4000-8000-000000000002", limitMicroUsd: 500_000 },
  research: { id: "11000000-0000-4000-8000-000000000003", limitMicroUsd: 500_000 },
  researchSearchUnitBound: 7,
};

void test("admin arguments require explicit staging target and workspace", () => {
  assert.throws(() =>
    parseAdminArguments(["status", "--target", "production", "--workspace", workspaceId]),
  );
  assert.throws(() => parseAdminArguments(["configure", "--target", "staging"]));
});

void test("staging target permits only the configured direct host or verified session pooler", () => {
  const password = "do-not-print-this";
  const direct = `postgresql://postgres:${password}@db.csmrsgywdosnrcfmnmuj.supabase.co:5432/postgres`;
  const pooler = `postgresql://postgres.csmrsgywdosnrcfmnmuj:${password}@aws-2-us-east-1.pooler.supabase.com:5432/postgres`;
  assert.equal(validateStagingDatabaseUrl(direct), direct);
  assert.equal(validateStagingDatabaseUrl(pooler), pooler);
  assert.throws(
    () =>
      validateStagingDatabaseUrl(
        `postgresql://postgres:${password}@aws-2-us-east-1.pooler.supabase.com:5432/postgres`,
      ),
    (error: unknown) => error instanceof Error && !error.message.includes(password),
  );
  assert.throws(() =>
    validateStagingDatabaseUrl(
      `postgresql://postgres:${password}@db.other-project.supabase.co:5432/postgres`,
    ),
  );
  assert.throws(() =>
    validateStagingDatabaseUrl(
      `postgresql://postgres:${password}@aws-2-us-east-1.pooler.supabase.com:6543/postgres`,
    ),
  );
});

void test("manifest requires distinct inference allowances and a valid explicit search-unit bound", () => {
  assert.equal(validateManifest(manifest, workspaceId).firecrawl, undefined);
  assert.throws(() => validateManifest({ ...manifest, researchSearchUnitBound: 6 }, workspaceId));
  assert.throws(() =>
    validateManifest(
      { ...manifest, research: { ...manifest.research, id: manifest.assistant.id } },
      workspaceId,
    ),
  );
  assert.throws(() =>
    validateManifest({ ...manifest, rate: { ...manifest.rate, provider: "other" } }, workspaceId),
  );
  assert.throws(() =>
    validateManifest(
      { ...manifest, workspaceId: "11000000-0000-4000-8000-000000000099" },
      workspaceId,
    ),
  );
});
