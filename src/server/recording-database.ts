import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import { createRecordingRepository } from "../db/recording-repository";

// Workflows do not have OpenNext's request context. Every durable step opens and
// closes its own Hyperdrive client; no connection crosses a sleep/step boundary.
export async function withRecordingDatabase<T>(
  connectionString: string,
  work: (repository: ReturnType<typeof createRecordingRepository>) => Promise<T>,
) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: true,
    fetch_types: false,
    connect_timeout: 10,
    idle_timeout: 20,
  });
  try {
    return await work(createRecordingRepository(drizzle(client, { schema })));
  } finally {
    await client.end({ timeout: 5 });
  }
}
