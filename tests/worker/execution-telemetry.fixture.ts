import { executionTrace, tracedOperations } from "../../src/telemetry/execution";
import { WorkspaceError } from "../../src/contracts/workspace";

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  batchId: "22222222-2222-4222-8222-222222222222",
};

export default {
  async fetch(request, env) {
    const mode = new URL(request.url).pathname;
    const expected = new Error("PRIVATE source content and provider credentials");
    try {
      if (mode === "/quality") {
        const result = await executionTrace(
          env,
          { ...scope, runId: scope.batchId, actorId: scope.workspaceId },
          "research.run.workflow",
          () => Promise.resolve({ status: "completed", quality: "insufficient-evidence" }),
          {
            actorType: "workflow",
            stage: "publishing",
            reusedSourceCount: 2,
            selectedSourceCount: 3,
            sourceBytes: 1200,
          },
        );
        return Response.json(result);
      }
      if (mode === "/workspace-error") {
        await executionTrace(env, scope, "research.workflow", () =>
          Promise.reject(new WorkspaceError("forbidden", "PRIVATE workspace message")),
        );
      }
      if (mode === "/detached" || mode === "/after-root") {
        const gate = Promise.withResolvers<void>();
        let late: Promise<unknown> | undefined;
        await executionTrace(env, scope, "assistant.start", () => {
          const run = () =>
            executionTrace(env, scope, "assistant.tool.notes_get", async () => {
              await gate.promise;
            });
          late = mode === "/detached" ? run() : gate.promise.then(run);
          return Promise.resolve();
        });
        gate.resolve();
        await late;
        return Response.json({ ok: true });
      }
      const result = await executionTrace(env, scope, "research.workflow", async () => {
        const port = tracedOperations(env, scope, "research.persistence", {
          async saveFinding() {
            await Promise.resolve();
            if (mode === "/failure") throw expected;
            if (mode === "/wrapped-failure") {
              const databaseError = Object.assign(
                new Error("PRIVATE SQL, bind values, prompt, and provider token"),
                { code: "23505" },
              );
              const wrapped = new Error("PRIVATE wrapper message", { cause: databaseError });
              throw new Error("PRIVATE outer message", { cause: wrapped });
            }
            return { status: mode === "/uncertain" ? "uncertain" : "completed", text: "PRIVATE" };
          },
        });
        return port.saveFinding();
      });
      return Response.json(result);
    } catch (error) {
      return Response.json({ sameError: error === expected }, { status: 503 });
    }
  },
} satisfies ExportedHandler;
