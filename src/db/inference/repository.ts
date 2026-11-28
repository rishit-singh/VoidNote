import { and, eq, sql } from "drizzle-orm";

import type { InferenceRate } from "../../ai/inference";
import {
  INFERENCE_MAX_SAFE_INTEGER,
  inferenceUsageMicroUsd,
  validInferenceTokenCount,
  validInferenceUsage,
} from "../../ai/inference";
import { idSchema, WorkspaceError } from "../../contracts/workspace";
import { inferenceBudgets, inferenceRates, inferenceReceipts } from "../inference-schema";
import type { Database } from "../repository";

export type ReserveInference = {
  workspaceId: string;
  budgetId: string;
  rateVersionId: string;
  requestId: string;
  model: string;
  inputTokenBound: number;
  maxOutputTokens: number;
};

export type SettleInference = {
  workspaceId: string;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
};

export type InferenceReceipt = typeof inferenceReceipts.$inferSelect;

export type InferenceBudgetAvailability = {
  workspaceId: string;
  budgetId: string;
  rateVersionId: string;
  limitMicroUsd: number;
  reservedMicroUsd: number;
  settledMicroUsd: number;
  availableMicroUsd: number;
  approved: boolean;
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function validIds(...values: string[]) {
  return values.every((value) => idSchema.safeParse(value).success);
}

function accountingNumber(value: bigint): number {
  if (value < 0n || value > BigInt(INFERENCE_MAX_SAFE_INTEGER)) {
    throw new WorkspaceError("conflict", "Inference accounting exceeds the supported range.");
  }

  return Number(value);
}

function remaining(budget: typeof inferenceBudgets.$inferSelect): number {
  const available =
    BigInt(budget.limitMicroUsd) - BigInt(budget.reservedMicroUsd) - BigInt(budget.settledMicroUsd);

  return accountingNumber(available > 0n ? available : 0n);
}

function approved(budget: typeof inferenceBudgets.$inferSelect): boolean {
  return budget.revokedAt === null && budget.approvedAt.getTime() <= Date.now();
}

async function lockRequest(tx: Transaction, workspaceId: string, requestId: string) {
  // Lock an identity even before its first row exists. The same order is used by
  // admission and settlement: request → budget. Hash collisions only serialize.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`inference:${workspaceId}:${requestId}`}, 0))`,
  );
}

async function readReceipt(tx: Transaction, workspaceId: string, requestId: string) {
  const [receipt] = await tx
    .select()
    .from(inferenceReceipts)
    .where(
      and(
        eq(inferenceReceipts.workspaceId, workspaceId),
        eq(inferenceReceipts.requestId, requestId),
      ),
    );

  return receipt;
}

export function createInferenceRepository(db: Database) {
  return {
    async getRate(rateVersionId: string): Promise<InferenceRate | null> {
      if (!validIds(rateVersionId)) {
        throw new WorkspaceError("service_unavailable", "Inference rate version is invalid.");
      }

      const [rate] = await db
        .select({
          id: inferenceRates.id,
          provider: inferenceRates.provider,
          model: inferenceRates.model,
          currency: inferenceRates.currency,
          inputMicroUsdPerMillionTokens: inferenceRates.inputMicroUsdPerMillionTokens,
          outputMicroUsdPerMillionTokens: inferenceRates.outputMicroUsdPerMillionTokens,
        })
        .from(inferenceRates)
        .where(eq(inferenceRates.id, rateVersionId));

      return rate ?? null;
    },

    async getBudgetAvailability(input: {
      workspaceId: string;
      budgetId: string;
    }): Promise<InferenceBudgetAvailability | null> {
      if (!validIds(input.workspaceId, input.budgetId)) {
        throw new WorkspaceError("service_unavailable", "Inference budget identity is invalid.");
      }

      const [budget] = await db
        .select()
        .from(inferenceBudgets)
        .where(
          and(
            eq(inferenceBudgets.workspaceId, input.workspaceId),
            eq(inferenceBudgets.id, input.budgetId),
          ),
        );

      if (!budget) {
        return null;
      }

      const isApproved = approved(budget);

      return {
        workspaceId: budget.workspaceId,
        budgetId: budget.id,
        rateVersionId: budget.rateVersionId,
        limitMicroUsd: budget.limitMicroUsd,
        reservedMicroUsd: budget.reservedMicroUsd,
        settledMicroUsd: budget.settledMicroUsd,
        availableMicroUsd: isApproved ? remaining(budget) : 0,
        approved: isApproved,
      };
    },

    async reserve(input: ReserveInference): Promise<InferenceReceipt> {
      if (
        !validIds(input.workspaceId, input.budgetId, input.rateVersionId, input.requestId) ||
        typeof input.model !== "string" ||
        input.model.length < 1 ||
        input.model.length > 256 ||
        !validInferenceTokenCount(input.inputTokenBound) ||
        !validInferenceTokenCount(input.maxOutputTokens)
      ) {
        throw new WorkspaceError("service_unavailable", "Inference admission is invalid.");
      }

      return db.transaction(async (tx) => {
        await lockRequest(tx, input.workspaceId, input.requestId);

        if (await readReceipt(tx, input.workspaceId, input.requestId)) {
          // A lost acknowledgement is an uncertain provider outcome. Even an
          // exact replay after settlement can never authorize another execution.
          throw new WorkspaceError("conflict", "Inference request was already admitted.");
        }

        const [budget] = await tx
          .select()
          .from(inferenceBudgets)
          .where(
            and(
              eq(inferenceBudgets.workspaceId, input.workspaceId),
              eq(inferenceBudgets.id, input.budgetId),
            ),
          )
          .for("update");

        if (!budget || !approved(budget) || budget.rateVersionId !== input.rateVersionId) {
          throw new WorkspaceError(
            "service_unavailable",
            "Inference budget does not match an approved rate version.",
          );
        }

        const [rate] = await tx
          .select()
          .from(inferenceRates)
          .where(eq(inferenceRates.id, input.rateVersionId));

        if (!rate || rate.model !== input.model) {
          throw new WorkspaceError(
            "service_unavailable",
            "Inference model does not match the pinned rate version.",
          );
        }

        const reservedMicroUsd = inferenceUsageMicroUsd(rate, {
          inputTokens: input.inputTokenBound,
          outputTokens: input.maxOutputTokens,
        });

        if (
          BigInt(reservedMicroUsd) >
          BigInt(budget.limitMicroUsd) -
            BigInt(budget.reservedMicroUsd) -
            BigInt(budget.settledMicroUsd)
        ) {
          throw new WorkspaceError("service_unavailable", "Inference budget is exhausted.");
        }

        await tx
          .update(inferenceBudgets)
          .set({
            reservedMicroUsd: accountingNumber(
              BigInt(budget.reservedMicroUsd) + BigInt(reservedMicroUsd),
            ),
          })
          .where(
            and(
              eq(inferenceBudgets.workspaceId, input.workspaceId),
              eq(inferenceBudgets.id, input.budgetId),
            ),
          );
        const [receipt] = await tx
          .insert(inferenceReceipts)
          .values({ ...input, reservedMicroUsd })
          .returning();

        if (!receipt) {
          throw new WorkspaceError("conflict", "Inference admission receipt could not be saved.");
        }

        return receipt;
      });
    },

    /** Call only with complete raw provider usage for this exact request. */
    async settle(input: SettleInference): Promise<InferenceReceipt> {
      if (!validIds(input.workspaceId, input.requestId) || !validInferenceUsage(input)) {
        throw new WorkspaceError("conflict", "Inference usage is invalid; its hold remains.");
      }

      return db.transaction(async (tx) => {
        await lockRequest(tx, input.workspaceId, input.requestId);
        const receipt = await readReceipt(tx, input.workspaceId, input.requestId);

        if (!receipt) {
          throw new WorkspaceError("conflict", "Inference usage has no matching admission.");
        }

        if (receipt.settledAt !== null) {
          if (
            receipt.inputTokens !== input.inputTokens ||
            receipt.outputTokens !== input.outputTokens
          ) {
            throw new WorkspaceError("conflict", "Inference usage conflicts with its receipt.");
          }

          return receipt;
        }

        const [budget] = await tx
          .select()
          .from(inferenceBudgets)
          .where(
            and(
              eq(inferenceBudgets.workspaceId, input.workspaceId),
              eq(inferenceBudgets.id, receipt.budgetId),
            ),
          )
          .for("update");

        const [rate] = await tx
          .select()
          .from(inferenceRates)
          .where(eq(inferenceRates.id, receipt.rateVersionId));

        if (
          !budget ||
          budget.rateVersionId !== receipt.rateVersionId ||
          !rate ||
          rate.model !== receipt.model
        ) {
          throw new WorkspaceError("conflict", "Inference usage cannot reconcile its pinned rate.");
        }

        const actualMicroUsd = inferenceUsageMicroUsd(rate, input);

        const reservedMicroUsd = accountingNumber(
          BigInt(budget.reservedMicroUsd) - BigInt(receipt.reservedMicroUsd),
        );

        // Actual provider usage can exceed the estimate and the approved limit.
        // Record that debt instead of hiding it; subsequent admissions fail.
        const settledMicroUsd = accountingNumber(
          BigInt(budget.settledMicroUsd) + BigInt(actualMicroUsd),
        );

        await tx
          .update(inferenceBudgets)
          .set({ reservedMicroUsd, settledMicroUsd })
          .where(
            and(
              eq(inferenceBudgets.workspaceId, input.workspaceId),
              eq(inferenceBudgets.id, receipt.budgetId),
            ),
          );
        const [settled] = await tx
          .update(inferenceReceipts)
          .set({
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            actualMicroUsd,
            settledAt: new Date(),
          })
          .where(
            and(
              eq(inferenceReceipts.workspaceId, input.workspaceId),
              eq(inferenceReceipts.requestId, input.requestId),
            ),
          )
          .returning();

        if (!settled) {
          throw new WorkspaceError("conflict", "Inference settlement receipt could not be saved.");
        }

        return settled;
      });
    },
  };
}
