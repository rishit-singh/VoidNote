import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Database } from "./repository";
import * as schema from "./schema";

export type { Database } from "./repository";

function requestConnectionString(): string {
  let env: ReturnType<typeof getCloudflareContext>["env"] | undefined;
  try {
    // OpenNext sets this context for Worker requests and initialized next dev.
    env = getCloudflareContext().env;
  } catch {
    // Plain local Node execution has no Cloudflare request context.
  }
  if (env && "HYPERDRIVE" in env && env.HYPERDRIVE != null) {
    const binding = env.HYPERDRIVE;
    if (
      typeof binding !== "object" ||
      !("connectionString" in binding) ||
      typeof binding.connectionString !== "string"
    ) {
      throw new Error("HYPERDRIVE must be a Hyperdrive binding");
    }
    return binding.connectionString;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Configure HYPERDRIVE or a local DATABASE_URL");
  return connectionString;
}

/** One request owns one client; Hyperdrive owns the underlying remote pool. */
export async function withDatabase<T>(work: (db: Database) => Promise<T>): Promise<T> {
  const client = postgres(requestConnectionString(), {
    max: 1,
    fetch_types: false,
    // Hyperdrive requires prepared statements with Postgres.js. Disabling them
    // causes extra protocol discovery messages that transaction pooling cannot
    // reliably handle (Cloudflare's Postgres.js guidance, October 2026).
    prepare: true,
    connect_timeout: 10,
    idle_timeout: 20,
  });
  try {
    return await work(drizzle(client, { schema }));
  } finally {
    await client.end({ timeout: 5 });
  }
}
