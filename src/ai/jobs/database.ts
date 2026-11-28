import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createAnalysisRepository } from "../../db/analysis";
import type { Database } from "../../db/repository";
import * as schema from "../../db/schema";
import { createSummaryBudgetRepository } from "../../db/summary-budget";

type DatabaseEnvironment = { HYPERDRIVE: { connectionString: string } };

// A request or durable step owns this client. It never crosses a Workflow wait.
export async function withJobDatabase<T>(
  env: DatabaseEnvironment,
  work: (db: Database) => Promise<T>,
): Promise<T> {
  const client = postgres(env.HYPERDRIVE.connectionString, {
    max: 1,
    prepare: true,
    fetch_types: false,
    connect_timeout: 10,
    idle_timeout: 20,
  });

  try {
    return await work(drizzle(client, { schema }));
  } finally {
    await client.end({ timeout: 5 });
  }
}

export function withAnalysisDatabase<T>(
  env: DatabaseEnvironment,
  work: (repository: ReturnType<typeof createAnalysisRepository>) => Promise<T>,
): Promise<T> {
  return withJobDatabase(env, (db) => work(createAnalysisRepository(db)));
}

export function withSummaryBudgetDatabase<T>(
  env: DatabaseEnvironment,
  work: (repository: ReturnType<typeof createSummaryBudgetRepository>) => Promise<T>,
): Promise<T> {
  return withJobDatabase(env, (db) => work(createSummaryBudgetRepository(db)));
}
