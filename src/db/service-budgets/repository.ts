import { and, eq, sql } from "drizzle-orm";

import { idSchema, WorkspaceError } from "../../contracts/workspace";
import type { Database } from "../repository";
import {
  serviceBudgetOperations,
  serviceBudgets,
  type ServiceBudgetProvider,
} from "../service-budget-schema";

const MAX_UNITS = Number.MAX_SAFE_INTEGER;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ReserveServiceBudget = {
  workspaceId: string;
  provider: ServiceBudgetProvider;
  budgetId: string;
  operationId: string;
  maximumUnits: number;
};

export type SettleServiceBudget = {
  workspaceId: string;
  provider: ServiceBudgetProvider;
  operationId: string;
  actualUnits: number;
};

export type ServiceBudgetReservation = {
  status: "created" | "existing-held" | "settled";
  operation: typeof serviceBudgetOperations.$inferSelect;
};

function validIds(...values: string[]) {
  return values.every((value) => idSchema.safeParse(value).success);
}

function validUnits(value: number, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum && value <= MAX_UNITS;
}

function validProvider(value: string): value is ServiceBudgetProvider {
  return value === "firecrawl" || value === "composio";
}

async function lockOperation(
  tx: Transaction,
  input: Pick<SettleServiceBudget, "workspaceId" | "provider" | "operationId">,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`service-budget:${input.workspaceId}:${input.provider}:${input.operationId}`}, 0))`,
  );
}

async function readOperation(
  tx: Transaction,
  input: Pick<SettleServiceBudget, "workspaceId" | "provider" | "operationId">,
) {
  const [operation] = await tx
    .select()
    .from(serviceBudgetOperations)
    .where(
      and(
        eq(serviceBudgetOperations.workspaceId, input.workspaceId),
        eq(serviceBudgetOperations.provider, input.provider),
        eq(serviceBudgetOperations.operationId, input.operationId),
      ),
    )
    .limit(1);

  return operation;
}

function checkedAccounting(value: bigint) {
  if (value < 0n || value > BigInt(MAX_UNITS)) {
    throw new WorkspaceError("conflict", "Service budget accounting exceeds its supported range.");
  }

  return Number(value);
}

export function createServiceBudgetRepository(db: Database) {
  return {
    /** Exact reservation replay reports its state; the caller's durable external
     * submission checkpoint remains the authority that can permit provider I/O. */
    async reserve(input: ReserveServiceBudget): Promise<ServiceBudgetReservation> {
      if (
        !validProvider(input.provider) ||
        !validIds(input.workspaceId, input.budgetId, input.operationId) ||
        !validUnits(input.maximumUnits, 1)
      ) {
        throw new WorkspaceError("service_unavailable", "Service budget reservation is invalid.");
      }

      return db.transaction(async (tx) => {
        await lockOperation(tx, input);
        const existing = await readOperation(tx, input);
        if (existing) {
          if (
            existing.budgetId !== input.budgetId ||
            existing.maximumUnits !== input.maximumUnits
          ) {
            throw new WorkspaceError("conflict", "Service operation reservation identity changed.");
          }

          return {
            status: existing.settledAt === null ? "existing-held" : "settled",
            operation: existing,
          };
        }

        const [budget] = await tx
          .select()
          .from(serviceBudgets)
          .where(
            and(
              eq(serviceBudgets.workspaceId, input.workspaceId),
              eq(serviceBudgets.provider, input.provider),
              eq(serviceBudgets.id, input.budgetId),
            ),
          )
          .for("update")
          .limit(1);

        if (!budget || budget.revokedAt !== null || budget.approvedAt.getTime() > Date.now()) {
          throw new WorkspaceError(
            "service_unavailable",
            "No approved service budget matches this operation.",
          );
        }

        const available =
          BigInt(budget.limitUnits) - BigInt(budget.reservedUnits) - BigInt(budget.settledUnits);
        if (BigInt(input.maximumUnits) > available) {
          throw new WorkspaceError("service_unavailable", "Service budget is exhausted.");
        }

        await tx
          .update(serviceBudgets)
          .set({
            reservedUnits: checkedAccounting(
              BigInt(budget.reservedUnits) + BigInt(input.maximumUnits),
            ),
          })
          .where(
            and(
              eq(serviceBudgets.workspaceId, input.workspaceId),
              eq(serviceBudgets.provider, input.provider),
              eq(serviceBudgets.id, input.budgetId),
            ),
          );

        const [operation] = await tx
          .insert(serviceBudgetOperations)
          .values({
            workspaceId: input.workspaceId,
            provider: input.provider,
            operationId: input.operationId,
            budgetId: input.budgetId,
            maximumUnits: input.maximumUnits,
          })
          .returning();

        if (!operation) {
          throw new WorkspaceError("conflict", "Service budget receipt could not be saved.");
        }

        return { status: "created", operation };
      });
    },

    /** Only complete, authoritative provider usage may reduce a held reservation. */
    async settle(input: SettleServiceBudget) {
      if (
        !validProvider(input.provider) ||
        !validIds(input.workspaceId, input.operationId) ||
        !validUnits(input.actualUnits)
      ) {
        throw new WorkspaceError("conflict", "Service usage is invalid; its hold remains.");
      }

      return db.transaction(async (tx) => {
        await lockOperation(tx, input);
        const operation = await readOperation(tx, input);
        if (!operation) {
          throw new WorkspaceError("conflict", "Service usage has no matching reservation.");
        }

        if (operation.actualUnits !== null) {
          if (operation.actualUnits !== input.actualUnits) {
            throw new WorkspaceError("conflict", "Service usage conflicts with its receipt.");
          }
          return operation;
        }

        if (input.actualUnits > operation.maximumUnits) {
          throw new WorkspaceError(
            "conflict",
            "Reported service usage exceeds its reserved maximum; the hold remains.",
          );
        }

        const [budget] = await tx
          .select()
          .from(serviceBudgets)
          .where(
            and(
              eq(serviceBudgets.workspaceId, input.workspaceId),
              eq(serviceBudgets.provider, input.provider),
              eq(serviceBudgets.id, operation.budgetId),
            ),
          )
          .for("update")
          .limit(1);

        if (!budget) {
          throw new WorkspaceError("conflict", "Service budget for this receipt is missing.");
        }

        const reservedUnits = checkedAccounting(
          BigInt(budget.reservedUnits) - BigInt(operation.maximumUnits),
        );
        const settledUnits = checkedAccounting(
          BigInt(budget.settledUnits) + BigInt(input.actualUnits),
        );

        await tx
          .update(serviceBudgets)
          .set({ reservedUnits, settledUnits })
          .where(
            and(
              eq(serviceBudgets.workspaceId, input.workspaceId),
              eq(serviceBudgets.provider, input.provider),
              eq(serviceBudgets.id, operation.budgetId),
            ),
          );

        const [settled] = await tx
          .update(serviceBudgetOperations)
          .set({ actualUnits: input.actualUnits, settledAt: new Date() })
          .where(
            and(
              eq(serviceBudgetOperations.workspaceId, input.workspaceId),
              eq(serviceBudgetOperations.provider, input.provider),
              eq(serviceBudgetOperations.operationId, input.operationId),
              sql`${serviceBudgetOperations.actualUnits} is null`,
            ),
          )
          .returning();

        if (!settled) {
          throw new WorkspaceError("conflict", "Service usage settlement could not be saved.");
        }

        return settled;
      });
    },
  };
}
