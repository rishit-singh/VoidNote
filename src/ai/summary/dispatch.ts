import { z } from "zod";

import { idSchema } from "../../contracts/workspace";
import type { SummaryEnvironment } from "./agent";

export const summaryWorkflowParamsSchema = z
  .object({ workspaceId: idSchema, jobId: idSchema })
  .strict();

export type SummaryWorkflowParams = z.infer<typeof summaryWorkflowParamsSchema>;

export function summaryExecutionName(params: SummaryWorkflowParams): string {
  const { workspaceId, jobId } = params;

  return `summary-${workspaceId}-${jobId}`;
}

export function summaryAgentName(params: SummaryWorkflowParams): string {
  const { workspaceId, jobId } = params;

  return `summary:${workspaceId}:${jobId}`;
}

type DispatchOperations = {
  start(params: SummaryWorkflowParams): Promise<string | null>;
  dispatched(params: SummaryWorkflowParams): Promise<void>;
  failed(params: SummaryWorkflowParams): void;
};

type MaintenanceOperations = DispatchOperations & {
  pendingDispatch(limit: number): Promise<readonly SummaryWorkflowParams[]>;
  pendingCancellationCleanup(limit: number): Promise<readonly SummaryWorkflowParams[]>;
  cancel(params: SummaryWorkflowParams): Promise<void>;
  cancellationCleaned(params: SummaryWorkflowParams): Promise<void>;
  cancellationFailed(params: SummaryWorkflowParams): void;
};

const MAINTENANCE_BATCH_SIZE = 10;

// Active jobs remain eligible after acknowledgement so each pass also repairs
// terminal Workflow/DB divergence. A successful confirmation rotates the job's
// check timestamp; failed reconciliation is retried without acknowledging it.
// Never acknowledge one job using evidence returned for another.
export async function dispatchSummaryJobs(
  pending: readonly SummaryWorkflowParams[],
  operations: DispatchOperations,
): Promise<void> {
  for (const params of pending) {
    try {
      const workflowId = await operations.start(params);
      if (workflowId === null) {
        continue;
      }

      if (workflowId !== summaryExecutionName(params)) {
        throw new Error("Summary dispatch returned a different workflow identity.");
      }

      await operations.dispatched(params);
    } catch {
      operations.failed(params);
    }
  }
}

export async function dispatchSummaryMaintenance(
  enabled: boolean,
  operations: MaintenanceOperations,
): Promise<void> {
  const cancelled = await operations.pendingCancellationCleanup(MAINTENANCE_BATCH_SIZE);

  for (const params of cancelled) {
    try {
      await operations.cancel(params);
      await operations.cancellationCleaned(params);
    } catch {
      operations.cancellationFailed(params);
    }
  }

  // Disabling inference never disables recovery of already accepted cleanup.
  if (!enabled) {
    return;
  }

  const pending = await operations.pendingDispatch(MAINTENANCE_BATCH_SIZE);
  await dispatchSummaryJobs(pending, operations);
}

export async function dispatchSummaryOutbox(
  env: Pick<SummaryEnvironment, "SUMMARY_ENABLED" | "SUMMARY_AGENT" | "HYPERDRIVE">,
): Promise<void> {
  const [{ getAgentByName }, { withAnalysisDatabase }] = await Promise.all([
    import("agents"),
    import("../jobs"),
  ]);

  await dispatchSummaryMaintenance(env.SUMMARY_ENABLED === "true", {
    pendingCancellationCleanup(limit) {
      return withAnalysisDatabase(env, (repo) => repo.pendingCancellationCleanup(limit));
    },
    async cancel(params) {
      const agent = await getAgentByName(env.SUMMARY_AGENT, summaryAgentName(params));

      // Do not use the best-effort notification helper: its swallowed failure
      // is not evidence that the durable cleanup request can be acknowledged.
      await agent.cancelSummary(params);
    },
    async cancellationCleaned({ workspaceId, jobId }) {
      await withAnalysisDatabase(env, (repo) => repo.cancellationCleaned(workspaceId, jobId));
    },
    cancellationFailed({ workspaceId, jobId }) {
      console.error("summary.cancel.cleanup_retry", { workspaceId, jobId });
    },
    pendingDispatch(limit) {
      return withAnalysisDatabase(env, (repo) => repo.pendingDispatch(limit));
    },
    async start(params) {
      const agent = await getAgentByName(env.SUMMARY_AGENT, summaryAgentName(params));

      return agent.startSummary(params);
    },
    async dispatched({ workspaceId, jobId }) {
      await withAnalysisDatabase(env, (repo) => repo.dispatched(workspaceId, jobId));
    },
    failed({ workspaceId, jobId }) {
      console.error("summary.dispatch.retry", { workspaceId, jobId });
    },
  });
}

// Call only after the authorized database cancellation commits. Runtime cleanup
// cannot turn a durable cancellation failure into an apparent success.
export async function cancelSummaryExecution(
  env: Pick<SummaryEnvironment, "SUMMARY_AGENT">,
  workspaceId: string,
  jobId: string,
): Promise<void> {
  const params = summaryWorkflowParamsSchema.parse({ workspaceId, jobId });

  try {
    const { getAgentByName } = await import("agents");
    const agent = await getAgentByName(env.SUMMARY_AGENT, summaryAgentName(params));
    await agent.cancelSummary(params);
  } catch {
    console.error("summary.cancel.cleanup_failed", { workspaceId, jobId });
  }
}
