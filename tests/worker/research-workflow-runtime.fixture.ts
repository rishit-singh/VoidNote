import type {
  ResearchAgentRunKey,
  ResearchAgentServices,
} from "../../src/contracts/research/execution";
import { ResearchWorkflowAgent as ApplicationResearchWorkflowAgent } from "../../src/ai/research/agent/runtime";
import { researchAgentName } from "../../src/ai/research/agent-identity";
import { observeScopedInferenceUsage } from "../../src/ai/inference/scoped-usage";
import { requestInferenceStreamUsage } from "../../src/ai/inference/stream-usage";
import type { ResearchRunPolicy } from "../../src/config/research-runs";
import type { ResearchAgentScope } from "../../src/contracts/research/agent";
import type {
  ResearchAgentExecution,
  ResearchAgentPublication,
} from "../../src/contracts/research/execution";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";

export const fixtureKey: ResearchAgentRunKey = { workspaceId, runId };
export const fixtureScope: ResearchAgentScope = {
  workspaceId,
  runId,
  actorId,
  operationId: runId,
  question: "Investigate the current status and evidence limits.",
  questions: [
    { id: "10000000-0000-4000-8000-000000000004", question: "What is the current status?" },
    { id: "10000000-0000-4000-8000-000000000005", question: "What remains unverified?" },
  ],
  noteId: null,
  personId: null,
  sourceUrls: [],
  discoverSources: true,
  timeframe: { mode: "current" },
};

export const fixturePolicy: ResearchRunPolicy = {
  version: "research-v1",
  promptVersion: "research-extract-v2",
  provider: "workers-ai",
  sourceProvider: "direct",
  maxSearchResults: 5,
  maxDiscoveredSources: 5,
  maxDiscoveryBytes: 128_000,
  discoveryTimeoutMs: 10_000,
  model: "@cf/fixture/research-workflow",
  budgetId: "10000000-0000-4000-8000-000000000006",
  rateVersionId: "10000000-0000-4000-8000-000000000007",
  executionVersion: "research-workflow-v3",
  maxModelSteps: 6,
  maxSearchCalls: 4,
  maxToolCalls: 12,
  scrapeUnitBound: 1,
  reportVersion: "research-report-v1",
  maxQuestions: 4,
  maxSources: 6,
  maxEvidenceBytes: 4_000,
  maxSnapshotAgeDays: 7,
  maxSourceBytes: 128_000,
  maxResponseBytes: 512_000,
  sourceTimeoutMs: 10_000,
  maxRedirects: 3,
  maxOutputTokens: 1024,
  maxInputTokens: 64_000,
  contextWindowTokens: 128_000,
  extractionTimeoutMs: 90_000,
  deadlineMs: 60_000,
  maxAttempts: 3,
  reasoningEffort: "none",
};

async function invoke<T>(operation: string, args: unknown[] = []): Promise<T> {
  const response = await fetch(`https://research-workflow-service.test/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    throw new Error(`Fixture ${operation} failed (${response.status}).`);
  }

  return response.json<T>();
}

/** Esbuild aliases the application adapter to this test-only native boundary. */
export function createOperations(): ResearchAgentServices {
  return {
    execution: (key) => invoke<ResearchAgentExecution>("execution", [key]),
    beginRun: (key) => invoke<boolean>("beginRun", [key]),
    isCancelled: (key) => invoke<boolean>("isCancelled", [key]),
    executeTool: (name, input, context) => invoke("executeTool", [name, input, context]),
    publishReport: (scope, input, operationId) =>
      invoke<ResearchAgentPublication>("publishReport", [scope, input, operationId]),
    failRun: (scope, message) => invoke("failRun", [scope, message]),
    admitModelRequest: (scope, policy) => invoke("admitModelRequest", [scope, policy]),
  };
}

function modelToolResult(toolName: string, input: unknown, toolCallId: string) {
  const data = {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(input) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const usage = { response: "", usage: { prompt_tokens: 32, completion_tokens: 18 } };
  const text = [data, usage].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${text}data: [DONE]\n\n`));
      controller.close();
    },
  });
}

export class ResearchWorkflowAgent extends ApplicationResearchWorkflowAgent {
  override getAIBinding(): Ai {
    const binding = {
      async run(_model: unknown, params: unknown) {
        const response = await fetch("https://research-workflow-service.test/model", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
        });

        if (!response.ok) {
          throw new Error("Fixture model boundary rejected the request.");
        }

        const next = await response.json<{
          toolName: string;
          input: unknown;
          toolCallId: string;
        }>();

        return modelToolResult(next.toolName, next.input, next.toolCallId);
      },
    } as unknown as Ai;

    return observeScopedInferenceUsage(
      requestInferenceStreamUsage(binding),
      () => this.currentResearchModelRequest(),
      async (scope, usage) => {
        await invoke("settleUsage", [scope, usage]);
      },
    );
  }

  async inspectFixture() {
    return {
      state: this.state,
      submissions: await this.listSubmissions({ limit: 20 }),
    };
  }
}

export { ResearchInvestigationWorkflow } from "../../src/ai/research/agent/workflow";

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const url = new URL(request.url);
    const namespace = env.RESEARCH_WORKFLOW_AGENT as DurableObjectNamespace<ResearchWorkflowAgent>;
    const agent = namespace.get(namespace.idFromName(researchAgentName(fixtureKey)));

    try {
      if (url.pathname === "/start") {
        return Response.json({ workflowId: await agent.startResearch(fixtureKey) });
      }

      if (url.pathname === "/inspect") {
        const workflow = await env.RESEARCH_INVESTIGATION_WORKFLOW.get(runId);

        return Response.json({
          workflow: await workflow.status(),
          agent: await Promise.resolve(agent.inspectFixture()),
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
