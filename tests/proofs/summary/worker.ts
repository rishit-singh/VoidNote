import type { StepContext, TurnConfig } from "@cloudflare/think";

import { readSummarySnapshot, validateSummaryAnalysis } from "../../../src/ai/context";
import { withAnalysisDatabase } from "../../../src/ai/jobs";
import { summaryPolicy } from "../../../src/ai/runtime";
import { SummaryAgent as ProductionSummaryAgent, SummaryWorkflow } from "../../../src/ai/summary";
import { proof } from "./fixture";
import { proofInstructions, proofInstructionVersion } from "./instructions";

export { SummaryWorkflow };

// Only instrumentation and reasoning effort differ from production.
export class SummaryAgent extends ProductionSummaryAgent {
  private metricsTable() {
    void this.sql`create table if not exists proof_metrics (
      call_id text not null, step_number integer not null, payload text not null,
      primary key (call_id, step_number)
    )`;
  }

  override async beforeTurn(): Promise<TurnConfig> {
    const config = await super.beforeTurn();
    return {
      ...config,
      ...(this.state.scope?.jobId !== proof.jobs[0]
        ? {
            instructions: `${String(config.instructions)}\n\n${proofInstructions}`,
          }
        : {}),
      providerOptions: { ...config.providerOptions, "workers-ai": { reasoning_effort: "none" } },
    };
  }

  override async onStepEnd(ctx: StepContext): Promise<void> {
    await super.onStepEnd(ctx);
    this.metricsTable();
    const usage = ctx.usage;
    const payload = JSON.stringify({
      model: ctx.model,
      proofInstructionVersion:
        this.state.scope?.jobId === proof.jobs[0] ? "base-v1" : proofInstructionVersion,
      stepNumber: ctx.stepNumber,
      finishReason: ctx.finishReason,
      recordedAt: new Date().toISOString(),
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
      cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? null,
      reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? null,
      responseTimeMs: ctx.performance.responseTimeMs,
      stepTimeMs: ctx.performance.stepTimeMs,
      timeToFirstOutputMs: ctx.performance.timeToFirstOutputMs ?? null,
      toolNames: ctx.toolCalls.map((call) => call.toolName),
    });
    void this
      .sql`insert or replace into proof_metrics values (${ctx.callId}, ${ctx.stepNumber}, ${payload})`;
  }

  async proofMetrics(): Promise<string[]> {
    this.metricsTable();
    return Promise.resolve(
      this.sql<{ payload: string }>`select payload from proof_metrics order by step_number`.map(
        (row) => row.payload,
      ),
    );
  }
}

type ProofEnvironment = Omit<Cloudflare.Env, "SUMMARY_AGENT"> & {
  SUMMARY_AGENT: DurableObjectNamespace<SummaryAgent>;
  PROOF_TOKEN: string;
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      return new Response("Local proof only", { status: 403 });
    }
    if (!env.PROOF_TOKEN || request.headers.get("authorization") !== `Bearer ${env.PROOF_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const match = /^\/runs\/([123])$/.exec(url.pathname);
    const jobId = match ? proof.jobs[Number(match[1]) - 1] : undefined;
    if (!jobId || !["GET", "POST"].includes(request.method)) {
      return new Response("Not found", { status: 404 });
    }
    const params = { workspaceId: proof.workspaceId, jobId };
    const agent = env.SUMMARY_AGENT.get(
      env.SUMMARY_AGENT.idFromName(`summary:${proof.workspaceId}:${jobId}`),
    );
    if (request.method === "POST") {
      const job = await withAnalysisDatabase(env, (repo) =>
        repo.request(
          proof.principal,
          proof.workspaceId,
          { noteId: proof.noteId, commandId: jobId },
          summaryPolicy(proof.model),
        ),
      );
      if (job.status === "queued" || job.status === "running") {
        ctx.waitUntil(
          agent.startSummary(params).catch(() => {
            console.error("proof.dispatch.failed", { jobId });
          }),
        );
      }
      return Response.json({ job }, { status: 202 });
    }
    const job = await withAnalysisDatabase(env, (repo) =>
      repo.get(proof.principal, proof.workspaceId, jobId),
    );
    const metrics = (await agent.proofMetrics()).map((item): unknown => JSON.parse(item));
    if (job.status !== "succeeded") {
      return Response.json({ job, metrics });
    }
    const saved = await withAnalysisDatabase(env, (repo) =>
      repo.result(proof.principal, proof.workspaceId, jobId),
    );
    const evidence = await withAnalysisDatabase(env, (repo) =>
      repo.evidence(proof.principal, proof.workspaceId, jobId),
    );
    const snapshot = await readSummarySnapshot(
      env.RECORDING_ARTIFACTS,
      proof.workspaceId,
      jobId,
      evidence.reference,
      evidence.maxContextBytes,
    );
    validateSummaryAnalysis(saved.summary.analysis, snapshot);
    return Response.json({
      job,
      ...saved,
      metrics,
      citationValidation: "passed",
      sourcePassages: snapshot.passages.length,
      contextBytes: new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
    });
  },
} satisfies ExportedHandler<ProofEnvironment>;
