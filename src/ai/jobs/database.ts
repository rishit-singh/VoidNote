import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createAnalysisRepository } from "../../db/analysis";
import * as schema from "../../db/schema";

type DatabaseEnvironment = { HYPERDRIVE: { connectionString: string } };

// A request or durable step owns this client. It never crosses a Workflow wait.
export async function withAnalysisDatabase<T>(
  env: DatabaseEnvironment,
  work: (repository: ReturnType<typeof createAnalysisRepository>) => Promise<T>,
): Promise<T> {
  const client = postgres(env.HYPERDRIVE.connectionString, {
    max: 1,
    prepare: true,
    fetch_types: false,
    connect_timeout: 10,
    idle_timeout: 20,
  });

  try {
    return await work(createAnalysisRepository(drizzle(client, { schema })));
  } finally {
    await client.end({ timeout: 5 });
  }
}
