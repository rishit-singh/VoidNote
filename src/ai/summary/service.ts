import { createHash } from "node:crypto";

import type { ContextReference } from "../context";
import { contextReferenceSchema, readSummarySnapshot, validateSummaryContext } from "../context";
import { withAnalysisDatabase, withSummaryBudgetDatabase } from "../jobs";
import type { SummaryPolicy, SummaryUsage } from "../runtime";
import { summaryPolicySchema, summaryReservationMicroUsd } from "../runtime";
import type { SummaryEnvironment } from "./agent";
import { renderSummaryPrompt } from "./instructions";
import { interpretSummaryOutput, SummaryOutputValidationError } from "./output";

export async function getSummaryExecution(
  env: SummaryEnvironment,
  workspaceId: string,
  jobId: string,
) {
  const job = await withAnalysisDatabase(env, (repo) => repo.execution(workspaceId, jobId));
  summaryPolicySchema.parse(job.policy);

  return job;
}

export async function reserveSummaryInference(
  env: SummaryEnvironment,
  workspaceId: string,
  jobId: string,
  policy: SummaryPolicy,
  inputTokenBound?: number,
): Promise<void> {
  const budgetId = policy.budgetId;
  if (!budgetId) {
    // Preserve the historical isolated proof, but never let a budgetless old job
    // consume a newly enabled application's allowance.
    if (env.SUMMARY_BUDGET_ID) {
      throw new Error("This summary has no pinned inference allowance. Request a new summary.");
    }

    return;
  }

  if (policy.budgetAccounting && inputTokenBound === undefined) {
    throw new Error("The complete model request is required for Summary admission.");
  }

  const reservationMicroUsd = summaryReservationMicroUsd(
    policy,
    policy.budgetAccounting ? inputTokenBound : undefined,
  );
  await withSummaryBudgetDatabase(env, (repo) =>
    repo.reserve({
      budgetId,
      workspaceId,
      jobId,
      model: policy.model,
      reservationMicroUsd,
      ...(policy.budgetAccounting
        ? { accountingVersion: policy.budgetAccounting, inputTokenBound }
        : {}),
    }),
  );
}

export async function settleSummaryInference(
  env: SummaryEnvironment,
  workspaceId: string,
  jobId: string,
  usage: SummaryUsage,
): Promise<void> {
  await withSummaryBudgetDatabase(env, (repo) => repo.settle({ workspaceId, jobId, ...usage }));
}

export async function prepareSummaryContext(
  env: SummaryEnvironment,
  workspaceId: string,
  jobId: string,
): Promise<ContextReference> {
  const job = await getSummaryExecution(env, workspaceId, jobId);

  if (job.context) {
    return contextReferenceSchema.parse(job.context);
  }

  const context = validateSummaryContext(
    await withAnalysisDatabase(env, (repo) => repo.prepareContext(workspaceId, jobId)),
  );
  const body = JSON.stringify(context);

  if (new TextEncoder().encode(body).byteLength > job.policy.maxContextBytes) {
    throw new Error("Conversation exceeds this proof's complete-input context budget.");
  }

  const checksum = createHash("sha256").update(body).digest("hex");
  const reference = contextReferenceSchema.parse({
    snapshotId: context.snapshotId,
    objectKey: `analysis/${workspaceId}/${jobId}/context-${checksum}.json`,
    checksum,
    source: context.source,
    noteRevision: context.noteRevision,
    profiles: context.people.map((person) => ({
      personId: person.personId,
      revision: person.revision,
    })),
  });

  // Content-addressed writes are safe to repeat. Only the pinned reference is
  // visible to a job; interrupted pre-pin writes are private orphan candidates.
  await env.RECORDING_ARTIFACTS.put(reference.objectKey, body, {
    httpMetadata: { contentType: "application/json" },
  });

  return withAnalysisDatabase(env, (repo) => repo.pinContext(workspaceId, jobId, reference));
}

async function loadContext(
  env: SummaryEnvironment,
  workspaceId: string,
  jobId: string,
  input: ContextReference,
) {
  const job = await getSummaryExecution(env, workspaceId, jobId);
  const reference = contextReferenceSchema.parse(input);
  const pinned = contextReferenceSchema.parse(job.context);

  if (JSON.stringify(reference) !== JSON.stringify(pinned)) {
    throw new Error("Context reference does not match the accepted job.");
  }

  const context = await readSummarySnapshot(
    env.RECORDING_ARTIFACTS,
    workspaceId,
    jobId,
    reference,
    job.policy.maxContextBytes,
  );

  return { context, job };
}

export async function loadSummaryPrompt(
  env: SummaryEnvironment,
  workspaceId: string,
  jobId: string,
  reference: ContextReference,
): Promise<string> {
  const { context, job } = await loadContext(env, workspaceId, jobId, reference);

  return renderSummaryPrompt(job.policy.promptVersion, context).user;
}

export async function publishSummary(
  env: SummaryEnvironment,
  workspaceId: string,
  jobId: string,
  reference: ContextReference,
  input: unknown,
) {
  const { context, job } = await loadContext(env, workspaceId, jobId, reference);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > job.policy.maxOutputBytes) {
    throw new SummaryOutputValidationError();
  }

  const analysis = interpretSummaryOutput(job.policy.promptVersion, input, context);

  if (new TextEncoder().encode(JSON.stringify(analysis)).byteLength > job.policy.maxOutputBytes) {
    throw new SummaryOutputValidationError();
  }

  return withAnalysisDatabase(env, (repo) => repo.publish(workspaceId, jobId, reference, analysis));
}

export async function failSummary(
  env: SummaryEnvironment,
  workspaceId: string,
  jobId: string,
  status: "failed" | "blocked" | "superseded",
  message: string,
) {
  await withAnalysisDatabase(env, (repo) => repo.fail(workspaceId, jobId, status, message));
}
