import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { z } from "zod";

import { analysisJobSchema } from "../../../src/contracts/analysis";
import { proof, proofBudget } from "./fixture";

const attempt = Number(process.argv[2]);
assert.ok(Number.isInteger(attempt) && attempt >= 1 && attempt <= proofBudget.maxAttempts);
const tokenFile = new URL("./.dev.vars", import.meta.url);
const token = /^PROOF_TOKEN=(.+)$/m.exec(await readFile(tokenFile, "utf8"))?.[1];
assert.ok(token, "Generate a local proof token first; never put it in CLI arguments.");
const reserve =
  (proofBudget.inputTokensUpperBound * proofBudget.inputDollarsPerMillion +
    proofBudget.outputTokensUpperBound * proofBudget.outputDollarsPerMillion) /
  1_000_000;
assert.ok(reserve * proofBudget.maxAttempts <= proofBudget.maxEstimatedDollars);
const evidenceDirectory = new URL("../../../.wrangler/summary-proof-evidence/", import.meta.url);
await mkdir(evidenceDirectory, { recursive: true });
const verifyReload = process.argv.includes("--verify-reload");
const original = verifyReload
  ? z
      .object({ job: analysisJobSchema, metrics: z.array(z.unknown()) })
      .parse(
        JSON.parse(await readFile(new URL(`result-${attempt}.json`, evidenceDirectory), "utf8")),
      )
  : null;
// Exclusive per-attempt receipt survives process failure. Re-running the same
// attempt only retries its exact command; it never advances to another attempt.
try {
  await writeFile(
    new URL(`attempt-${attempt}.json`, evidenceDirectory),
    JSON.stringify(
      {
        attempt,
        jobId: proof.jobs[attempt - 1],
        model: proof.model,
        reservedAt: new Date().toISOString(),
        estimatedUpperBoundDollars: reserve,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
}

const endpoint = `http://127.0.0.1:8794/runs/${attempt}`;
const headers = { authorization: `Bearer ${token}` };
const started = performance.now();
const accepted = await fetch(endpoint, { method: "POST", headers });
assert.equal(accepted.status, 202, `Proof admission failed (${accepted.status}).`);
const first = z.object({ job: analysisJobSchema }).parse(await accepted.json());
const replay = await fetch(endpoint, { method: "POST", headers });
const repeated = z.object({ job: analysisJobSchema }).parse(await replay.json());
assert.equal(first.job.id, repeated.job.id);
console.log(
  JSON.stringify({
    acceptedJob: first.job.id,
    exactReplay: true,
    acceptanceMs: Math.round(performance.now() - started),
    reservedCostUpperBound: reserve,
  }),
);

const responseSchema = z
  .object({
    job: analysisJobSchema,
    metrics: z.array(
      z
        .object({
          inputTokens: z.number().nullable(),
          outputTokens: z.number().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
for (let check = 0; check < 240; check++) {
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200, `Proof status failed (${response.status}).`);
  const report = responseSchema.parse(await response.json());
  if (!["queued", "running"].includes(report.job.status)) {
    const usageKnown =
      report.metrics.length === 1 &&
      report.metrics[0]!.inputTokens !== null &&
      report.metrics[0]!.inputTokens > 0 &&
      report.metrics[0]!.outputTokens !== null &&
      report.metrics[0]!.outputTokens > 0;
    const estimatedDollars = usageKnown
      ? (report.metrics[0]!.inputTokens! * proofBudget.inputDollarsPerMillion +
          report.metrics[0]!.outputTokens! * proofBudget.outputDollarsPerMillion) /
        1_000_000
      : null;
    const complete = {
      ...report,
      attempt,
      elapsedMs: Math.round(performance.now() - started),
      estimatedDollars,
      reservedCostUpperBound: reserve,
      evidence: "local workerd + isolated PostgreSQL/local R2 + live Workers AI",
    };
    if (original) {
      assert.equal(report.job.status, "succeeded");
      assert.equal(report.job.resultId, original.job.resultId);
      assert.deepEqual(report.metrics, original.metrics);
    }
    await writeFile(
      new URL(`${verifyReload ? "reload" : "result"}-${attempt}.json`, evidenceDirectory),
      JSON.stringify(complete, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          status: report.job.status,
          resultId: report.job.resultId,
          metrics: report.metrics,
          elapsedMs: complete.elapsedMs,
          estimatedDollars,
          verifiedReload: verifyReload,
        },
        null,
        2,
      ),
    );
    process.exitCode = report.job.status === "succeeded" ? 0 : 1;
    break;
  }
  if (check === 239)
    throw new Error("Proof remains pending; preserve its exact job and inspect before proceeding.");
  await delay(1000);
}
