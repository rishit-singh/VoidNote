import { emitSummaryUsage, summaryTrace, summaryTraceId } from "../../src/telemetry/summary";

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  workflowId: "summary-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222",
  snapshotId: "33333333-3333-4333-8333-333333333333",
  resultId: "44444444-4444-4444-8444-444444444444",
};

export default {
  async fetch(request: Request, env): Promise<Response> {
    const mode = new URL(request.url).pathname.slice(1);
    try {
      if (mode === "fail-domain") {
        const expectedError = new Error("PRIVATE provider stack and transcript content");
        try {
          await summaryTrace(env, scope, "workflow.generate", () => {
            throw expectedError;
          });
        } catch (error) {
          return Response.json({
            outcome: "domain-error",
            sameError: error === expectedError,
          });
        }
      } else if (mode === "usage") {
        await emitSummaryUsage(env, scope, {
          model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
          inputTokens: 123,
          outputTokens: 45,
          responseTimeMs: 234.5,
          stepTimeMs: 240,
          timeToFirstOutputMs: 81.25,
        });
      } else if (mode === "invalid-usage") {
        await emitSummaryUsage(env, scope, {
          model: "PRIVATE transcript model",
          inputTokens: -1,
          outputTokens: 4.5,
          responseTimeMs: Number.POSITIVE_INFINITY,
          stepTimeMs: -1,
          timeToFirstOutputMs: Number.NaN,
        });
      } else if (mode === "invalid-scope") {
        const invalidScope = { ...scope, workspaceId: "PRIVATE workspace value" };
        await summaryTrace(env, invalidScope, "request.accept", () => undefined);
        return Response.json({ outcome: "ok", traceId: await summaryTraceId(invalidScope) });
      } else if (mode === "complete") {
        await summaryTrace(env, scope, "workflow.complete", () => ({ status: "succeeded" }));
      } else {
        await summaryTrace(
          env,
          scope,
          "workflow.generate",
          () => "PRIVATE prompt and transcript content",
          { inputTokens: 123, outputTokens: 45 },
        );
      }
      return Response.json(
        mode === "ok" ? { outcome: "ok", traceId: await summaryTraceId(scope) } : { outcome: "ok" },
      );
    } catch {
      return Response.json({ outcome: "domain-error" });
    }
  },
} satisfies ExportedHandler<CloudflareEnv>;
