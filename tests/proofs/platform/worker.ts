import { createHash, timingSafeEqual } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { assistantAgentName } from "../../../src/ai/assistant";
import { dispatchAssistantArtifacts } from "../../../src/ai/assistant-artifacts";
import { AssistantAgent as ProductionAssistantAgent } from "../../../src/ai/assistant-runtime";
import { SummaryAgent as ProductionSummaryAgent } from "../../../src/ai/summary";
import { withJobDatabase } from "../../../src/ai/jobs";
import { dispatchResearchItem } from "../../../src/ai/research";
import { summaryPolicy } from "../../../src/ai/runtime";
import { dispatchSummaryOutbox } from "../../../src/ai/summary";
import { readAssistantPolicy } from "../../../src/config/assistant";
import { readResearchPolicy } from "../../../src/config/research";
import { requestResearchSchema, retryResearchSchema } from "../../../src/contracts/research";
import { WorkspaceError } from "../../../src/contracts/workspace";
import { createAnalysisRepository } from "../../../src/db/analysis";
import { createAssistantRepository } from "../../../src/db/assistant";
import { inferenceBudgets, inferenceReceipts } from "../../../src/db/inference-schema";
import type { Database } from "../../../src/db/repository";
import { createResearchRepository } from "../../../src/db/research";
import { summaryInferenceBudgets, summaryInferenceReservations } from "../../../src/db/schema";
import { observeUsageDiagnostics } from "./usage-diagnostics";

// Production composition: no model, instructions, services or output mocks.
export { SummaryWorkflow } from "../../../src/ai/summary";
export { ResearchWorkflow } from "../../../src/ai/research/workflow";

export class AssistantAgent extends ProductionAssistantAgent {
  override getAIBinding(): Ai {
    return observeUsageDiagnostics(super.getAIBinding(), (diagnostic) => {
      console.log("proof.assistant-usage", JSON.stringify(diagnostic));
    });
  }
}

// Observe only protocol/count metadata; production generation and accounting are unchanged.
export class SummaryAgent extends ProductionSummaryAgent {
  protected override observeSummaryAIBinding(binding: Ai): Ai {
    return super.observeSummaryAIBinding(
      observeUsageDiagnostics(binding, (diagnostic) => {
        console.log("proof.usage", JSON.stringify(diagnostic));
      }),
    );
  }
}

type ProofEnvironment = Cloudflare.Env & { PROOF_TOKEN?: string; PROOF_MANIFEST?: string };
const model = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const manifestSchema = z.object({
  version: z.literal(1),
  database: z.literal("voidnote_platform_acceptance_20261125"),
  model: z.literal(model),
  principal: z.object({ id: z.uuid(), email: z.literal("platform-acceptance@example.invalid") }),
  workspaceId: z.uuid(),
  noteId: z.uuid(),
  threadId: z.uuid(),
  rateVersionId: z.uuid(),
  budgets: z.object({ chat: z.uuid(), research: z.uuid(), legacySummary: z.uuid() }),
});
type Manifest = z.infer<typeof manifestSchema>;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

function authorized(request: Request, env: ProofEnvironment) {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  if (!env.PROOF_TOKEN || env.PROOF_TOKEN.length < 32) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(request.headers.get("PROOF_TOKEN") ?? ""), digest(env.PROOF_TOKEN));
}

function scope(env: ProofEnvironment) {
  const proof = manifestSchema.parse(JSON.parse(env.PROOF_MANIFEST ?? "null"));
  // workerd presents a synthetic Hyperdrive host/port for its TCP designator;
  // the local destination is pinned by this proof's Wrangler configuration.
  const database = new URL(env.HYPERDRIVE.connectionString);
  if (database.pathname !== `/${proof.database}` || env.HYPERDRIVE.database !== proof.database) {
    throw new Error("Proof requires its dedicated acceptance database.");
  }
  if (
    env.ASSISTANT_BUDGET_ID !== proof.budgets.chat ||
    env.RESEARCH_BUDGET_ID !== proof.budgets.research ||
    env.SUMMARY_BUDGET_ID !== proof.budgets.legacySummary ||
    env.ASSISTANT_RATE_VERSION_ID !== proof.rateVersionId ||
    env.RESEARCH_RATE_VERSION_ID !== proof.rateVersionId ||
    [env.ASSISTANT_MODEL, env.RESEARCH_MODEL, env.SUMMARY_MODEL].some((value) => value !== model)
  ) {
    throw new Error("Proof environment must match the fixed manifest allowances and model.");
  }
  return proof;
}

async function body(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("JSON body required.");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid request body chunk.");
      bytes += chunk.byteLength;
      if (bytes > 32_768) {
        await reader.cancel();
        throw new Error("Request body exceeds 32 KiB.");
      }
      parts.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

async function ledger(db: Database, proof: Manifest, budgetId: string) {
  const [budget] = await db
    .select()
    .from(inferenceBudgets)
    .where(
      and(eq(inferenceBudgets.workspaceId, proof.workspaceId), eq(inferenceBudgets.id, budgetId)),
    );
  // These tables contain accounting metadata only, never prompts/credentials.
  const receipts = await db
    .select()
    .from(inferenceReceipts)
    .where(
      and(
        eq(inferenceReceipts.workspaceId, proof.workspaceId),
        eq(inferenceReceipts.budgetId, budgetId),
      ),
    )
    .orderBy(desc(inferenceReceipts.createdAt))
    .limit(100);
  return { scope: "whole-proof-budget", budget, receipts, receiptLimit: 100 };
}

export default {
  async fetch(request: Request, env: ProofEnvironment): Promise<Response> {
    if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
    try {
      const proof = scope(env);
      const url = new URL(request.url);
      const { principal, workspaceId } = proof;
      if (request.method === "POST" && url.pathname === "/chat") {
        const input = z
          .object({ turnId: z.uuid(), text: z.string().trim().min(1).max(16_000) })
          .strict()
          .parse(await body(request));
        const turn = await withJobDatabase(env, (db) =>
          createAssistantRepository(db).requestTurn(
            principal,
            workspaceId,
            proof.threadId,
            input.turnId,
            input.text,
            readAssistantPolicy(env),
          ),
        );
        if (env.ASSISTANT_ENABLED === "true" && ["queued", "running"].includes(turn.status)) {
          const agent = env.ASSISTANT_AGENT.get(
            env.ASSISTANT_AGENT.idFromName(
              assistantAgentName({ workspaceId, threadId: proof.threadId }),
            ),
          );
          await agent.startTurn({ workspaceId, turnId: input.turnId });
        }
        return json({ turn }, 202);
      }
      if (request.method === "GET" && url.pathname === "/chat") {
        const turnId = z.uuid().parse(url.searchParams.get("turnId"));
        return json(
          await withJobDatabase(env, async (db) => {
            const repo = createAssistantRepository(db);
            const turn = await repo.getTurn(principal, workspaceId, turnId);
            if (turn.threadId !== proof.threadId)
              throw new WorkspaceError("not_found", "Proof turn not found.");
            return {
              turn,
              history: await repo.history(principal, workspaceId, proof.threadId, undefined, 50),
              accounting: await ledger(db, proof, proof.budgets.chat),
            };
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/summary") {
        const input = z
          .object({
            commandId: z.uuid(),
            reasoningEffort: z.enum(["none", "low"]).default("none"),
          })
          .strict()
          .parse(await body(request));
        const policy =
          env.SUMMARY_ENABLED === "true"
            ? {
                ...summaryPolicy(model, proof.budgets.legacySummary),
                reasoningEffort: input.reasoningEffort,
              }
            : null;
        if (policy && policy.promptVersion !== "summary-v7")
          throw new Error("Proof requires summary-v7 for new requests.");
        const job = await withJobDatabase(env, (db) =>
          createAnalysisRepository(db).request(
            principal,
            workspaceId,
            { commandId: input.commandId, noteId: proof.noteId },
            policy,
          ),
        );
        await dispatchSummaryOutbox(env);
        return json({ job }, 202);
      }
      if (request.method === "GET" && url.pathname === "/summary") {
        const jobId = z.uuid().parse(url.searchParams.get("jobId"));
        return json(
          await withJobDatabase(env, async (db) => {
            const repo = createAnalysisRepository(db);
            const job = await repo.get(principal, workspaceId, jobId);
            if (job.noteId !== proof.noteId)
              throw new WorkspaceError("not_found", "Proof job not found.");
            const [budget] = await db
              .select()
              .from(summaryInferenceBudgets)
              .where(eq(summaryInferenceBudgets.id, proof.budgets.legacySummary));
            const receipts = await db
              .select()
              .from(summaryInferenceReservations)
              .where(
                and(
                  eq(summaryInferenceReservations.workspaceId, workspaceId),
                  eq(summaryInferenceReservations.budgetId, proof.budgets.legacySummary),
                ),
              )
              .limit(100);
            return {
              job,
              result:
                job.status === "succeeded"
                  ? await repo.result(principal, workspaceId, jobId)
                  : null,
              accounting: { scope: "whole-proof-budget", budget, receipts, receiptLimit: 100 },
            };
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/research") {
        // Zod forbids omit() on this refined schema. Validate the transport
        // shape first, then bind scope and run the complete domain refinements.
        const payload = z
          .object({
            requestId: requestResearchSchema.shape.requestId,
            people: requestResearchSchema.shape.people,
          })
          .strict()
          .parse(await body(request));
        const input = requestResearchSchema.parse({ ...payload, workspaceId });
        if (input.people.some((person) => person.sourceUrls.length === 0)) {
          throw new Error("Each research target requires an explicit known public source URL.");
        }
        const batch = await withJobDatabase(env, (db) =>
          createResearchRepository(db).request(principal, input, readResearchPolicy(env)),
        );
        for (const item of batch.items) {
          if (["queued", "running"].includes(item.status)) {
            await dispatchResearchItem(env, {
              workspaceId,
              batchId: batch.id,
              personId: item.personId,
              generation: item.generation,
            });
          }
        }
        return json({ batch }, 202);
      }
      if (request.method === "POST" && url.pathname === "/research/retry") {
        const input = retryResearchSchema
          .omit({ workspaceId: true })
          .strict()
          .parse(await body(request));
        const batch = await withJobDatabase(env, (db) =>
          createResearchRepository(db).retry(principal, { ...input, workspaceId }),
        );
        for (const item of batch.items) {
          if (["queued", "running"].includes(item.status)) {
            await dispatchResearchItem(env, {
              workspaceId,
              batchId: batch.id,
              personId: item.personId,
              generation: item.generation,
            });
          }
        }
        return json({ batch }, 202);
      }
      if (request.method === "GET" && url.pathname === "/research") {
        const batchId = z.uuid().parse(url.searchParams.get("batchId"));
        return json(
          await withJobDatabase(env, async (db) => ({
            batch: await createResearchRepository(db).get(principal, workspaceId, batchId),
            accounting: await ledger(db, proof, proof.budgets.research),
          })),
        );
      }
      if (request.method === "POST" && url.pathname === "/reconcile") {
        return json(await dispatchAssistantArtifacts(env));
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof z.ZodError)
        return json({ error: "Invalid proof input", issues: error.issues }, 400);
      if (error instanceof WorkspaceError)
        return json({ error: error.code, message: error.message }, 409);
      // SQL/provider exception text can include credentials; never return/log it.
      return json(
        { error: "Proof operation failed; preserve exact IDs and inspect local state." },
        500,
      );
    }
  },
} satisfies ExportedHandler<ProofEnvironment>;
