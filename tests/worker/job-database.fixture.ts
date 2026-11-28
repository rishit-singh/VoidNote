import { sql } from "drizzle-orm";

import { withJobDatabase } from "../../src/ai/jobs/database";

interface Env {
  TEST_DATABASE_URL: string;
  FAULT_DATABASE_URL: string;
}

const unhandled: string[] = [];
addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  unhandled.push(reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason));
});

export default {
  async fetch(request, env) {
    const mode = new URL(request.url).pathname;
    if (mode === "/unhandled") return Response.json(unhandled.splice(0));
    let result: unknown;
    let caught: string | null = null;
    try {
      result = await withJobDatabase(
        {
          HYPERDRIVE: {
            connectionString:
              mode === "/force-close" || mode === "/failed-connect"
                ? env.FAULT_DATABASE_URL
                : env.TEST_DATABASE_URL,
          },
        },
        async (db) => {
          const rows = await db.execute(sql`SELECT 1 AS value`);
          if (mode === "/force-close") {
            await fetch("http://fault-control.invalid/close-next-write");
            await db.execute(sql`SELECT 1 AS value`);
          }
          if (mode === "/callback-error") throw new Error("fixture callback failure");
          return rows;
        },
      );
    } catch (error) {
      caught = error instanceof Error ? error.message : String(error);
    }
    // Keep this request alive while socket close/rejection callbacks settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return Response.json({ result, caught, unhandled: unhandled.splice(0) });
  },
} satisfies ExportedHandler<Env>;
