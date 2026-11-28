import { and, eq } from "drizzle-orm";

import { summaryUsageMicroUsd } from "../ai/runtime/budget";
import { idSchema, WorkspaceError } from "../contracts/workspace";
import type { Database } from "./repository";
import { analysisJobs, summaryInferenceBudgets, summaryInferenceReservations } from "./schema";

type ReserveSummaryBudget = {
  budgetId: string;
  workspaceId: string;
  jobId: string;
  model: string;
  reservationMicroUsd: number;
  accountingVersion?: "request-usage-v1" | undefined;
  inputTokenBound?: number | undefined;
};

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const INPUT_TOKEN_BOUND_MAX = 1_048_576;

type SettleSummaryBudget = {
  workspaceId: string;
  jobId: string;
  inputTokens: number;
  outputTokens: number;
};

function validTokenCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= POSTGRES_INTEGER_MAX;
}

export function createSummaryBudgetRepository(db: Database) {
  return {
    async reserve(input: ReserveSummaryBudget): Promise<void> {
      if (
        !idSchema.safeParse(input.budgetId).success ||
        !idSchema.safeParse(input.workspaceId).success ||
        !idSchema.safeParse(input.jobId).success ||
        !Number.isSafeInteger(input.reservationMicroUsd) ||
        input.reservationMicroUsd <= 0 ||
        input.reservationMicroUsd > POSTGRES_INTEGER_MAX ||
        (input.accountingVersion !== undefined && input.accountingVersion !== "request-usage-v1") ||
        (input.accountingVersion === "request-usage-v1" &&
          (!Number.isSafeInteger(input.inputTokenBound) ||
            input.inputTokenBound === undefined ||
            input.inputTokenBound <= 0 ||
            input.inputTokenBound > INPUT_TOKEN_BOUND_MAX))
      ) {
        throw new WorkspaceError(
          "service_unavailable",
          "Summary allowance configuration is invalid. Configure an approved budget before generating.",
        );
      }

      await db.transaction(async (tx) => {
        // Serialize admission against job cancellation/publication first. Do not
        // acquire note locks here: analysis operations already lock note → job.
        const [job] = await tx
          .select({ status: analysisJobs.status, policy: analysisJobs.policy })
          .from(analysisJobs)
          .where(
            and(eq(analysisJobs.workspaceId, input.workspaceId), eq(analysisJobs.id, input.jobId)),
          )
          .for("update");

        if (!job || (job.status !== "queued" && job.status !== "running")) {
          throw new WorkspaceError(
            "conflict",
            "Summary job is no longer active. Request a new summary to generate again.",
          );
        }
        if (
          job.policy.budgetId !== input.budgetId ||
          job.policy.model !== input.model ||
          job.policy.budgetAccounting !== input.accountingVersion
        ) {
          throw new WorkspaceError(
            "conflict",
            "Summary allowance does not match the accepted job. Request a new summary with the approved configuration.",
          );
        }

        const [existing] = await tx
          .select({ jobId: summaryInferenceReservations.jobId })
          .from(summaryInferenceReservations)
          .where(
            and(
              eq(summaryInferenceReservations.workspaceId, input.workspaceId),
              eq(summaryInferenceReservations.jobId, input.jobId),
            ),
          );
        if (existing) {
          // A committed reservation may already have reached the provider even
          // when its caller lost the acknowledgement. Never authorize a replay.
          throw new WorkspaceError(
            "conflict",
            "Summary allowance was already reserved for this job. Check its result; another generation requires a new summary request.",
          );
        }

        const [budget] = await tx
          .select()
          .from(summaryInferenceBudgets)
          .where(eq(summaryInferenceBudgets.id, input.budgetId))
          .for("update");
        if (
          !budget ||
          budget.model !== input.model ||
          (input.accountingVersion === "request-usage-v1"
            ? input.reservationMicroUsd > budget.reservationMicroUsd
            : input.reservationMicroUsd !== budget.reservationMicroUsd)
        ) {
          throw new WorkspaceError(
            "service_unavailable",
            "Summary allowance is missing or does not match the approved model and rate. Configure an approved budget before generating.",
          );
        }
        if (
          input.reservationMicroUsd >
          budget.limitMicroUsd - budget.reservedMicroUsd - budget.settledMicroUsd
        ) {
          throw new WorkspaceError(
            "service_unavailable",
            "Summary allowance is exhausted. Approve a new budget before generating again.",
          );
        }

        await tx
          .update(summaryInferenceBudgets)
          .set({ reservedMicroUsd: budget.reservedMicroUsd + input.reservationMicroUsd })
          .where(eq(summaryInferenceBudgets.id, input.budgetId));
        await tx.insert(summaryInferenceReservations).values({
          workspaceId: input.workspaceId,
          jobId: input.jobId,
          budgetId: input.budgetId,
          amountMicroUsd: input.reservationMicroUsd,
          inputTokenBound:
            input.accountingVersion === "request-usage-v1" ? input.inputTokenBound : null,
        });
      });
    },

    async settle(input: SettleSummaryBudget): Promise<void> {
      if (
        !idSchema.safeParse(input.workspaceId).success ||
        !idSchema.safeParse(input.jobId).success ||
        !validTokenCount(input.inputTokens) ||
        !validTokenCount(input.outputTokens)
      ) {
        throw new WorkspaceError(
          "conflict",
          "Summary usage is invalid; its allowance remains held.",
        );
      }

      await db.transaction(async (tx) => {
        // Same order as admission. Terminal jobs may receive late provider usage.
        const [job] = await tx
          .select({ policy: analysisJobs.policy })
          .from(analysisJobs)
          .where(
            and(eq(analysisJobs.workspaceId, input.workspaceId), eq(analysisJobs.id, input.jobId)),
          )
          .for("update");
        const [reservation] = await tx
          .select()
          .from(summaryInferenceReservations)
          .where(
            and(
              eq(summaryInferenceReservations.workspaceId, input.workspaceId),
              eq(summaryInferenceReservations.jobId, input.jobId),
            ),
          );
        if (!job || !reservation || job.policy.budgetId !== reservation.budgetId) {
          throw new WorkspaceError("conflict", "Summary usage does not match a reserved job.");
        }

        const [budget] = await tx
          .select()
          .from(summaryInferenceBudgets)
          .where(eq(summaryInferenceBudgets.id, reservation.budgetId))
          .for("update");
        if (!budget || budget.model !== job.policy.model) {
          throw new WorkspaceError("conflict", "Summary usage does not match the approved model.");
        }

        const actualMicroUsd = summaryUsageMicroUsd(budget.model, input);
        if (!Number.isSafeInteger(actualMicroUsd) || actualMicroUsd < 0) {
          throw new WorkspaceError("conflict", "Summary usage cost is invalid.");
        }
        if (reservation.settledAt !== null) {
          if (
            reservation.inputTokens !== input.inputTokens ||
            reservation.outputTokens !== input.outputTokens ||
            reservation.actualMicroUsd !== actualMicroUsd
          ) {
            throw new WorkspaceError(
              "conflict",
              "Summary usage conflicts with its settled receipt.",
            );
          }
          return;
        }

        const reservedMicroUsd = budget.reservedMicroUsd - reservation.amountMicroUsd;
        const settledMicroUsd = budget.settledMicroUsd + actualMicroUsd;
        if (reservedMicroUsd < 0 || !Number.isSafeInteger(settledMicroUsd)) {
          throw new WorkspaceError("conflict", "Summary allowance totals cannot be reconciled.");
        }
        await tx
          .update(summaryInferenceBudgets)
          .set({ reservedMicroUsd, settledMicroUsd })
          .where(eq(summaryInferenceBudgets.id, reservation.budgetId));
        await tx
          .update(summaryInferenceReservations)
          .set({
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            actualMicroUsd,
            settledAt: new Date(),
          })
          .where(
            and(
              eq(summaryInferenceReservations.workspaceId, input.workspaceId),
              eq(summaryInferenceReservations.jobId, input.jobId),
            ),
          );
      });
    },
  };
}
