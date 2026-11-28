import {
  ResearchAgent as ApplicationResearchAgent,
  researchAgentName,
} from "../../src/ai/research/agent";
import type {
  ResearchAgentExecution,
  ResearchAgentRunKey,
  ResearchAgentScope,
  ResearchAgentServices,
} from "../../src/ai/research/agent/services";
import { researchRunPolicySchema } from "../../src/config/research-runs";
import { observeScopedInferenceUsage } from "../../src/ai/inference/scoped-usage";
import { requestInferenceStreamUsage } from "../../src/ai/inference/stream-usage";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";
const actorId = "10000000-0000-4000-8000-000000000003";

async function invoke<T>(operation: string, args: unknown[] = []): Promise<T> {
  const response = await fetch(`https://research-agent-service.test/${operation}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`Fixture ${operation} failed (${response.status}): ${await response.text()}`);
  }
  return response.json<T>();
}

export class ResearchAgent extends ApplicationResearchAgent {
  protected override createServices(): ResearchAgentServices {
    return {
      execution: async (key: ResearchAgentRunKey) =>
        invoke<ResearchAgentExecution>("execution", [key]),
      beginRun: (key) => invoke("beginRun", [key]),
      isCancelled: (key) => invoke("isCancelled", [key]),
      executeTool: (name, input, context) => invoke("executeTool", [name, input, context]),
      publishReport: (scope, input, operationId) =>
        invoke("publishReport", [scope, input, operationId]),
      failRun: (scope, message) => invoke("failRun", [scope, message]),
      admitModelRequest: (scope, policy) => invoke("admitModelRequest", [scope, policy]),
    };
  }

  override getAIBinding(): Ai {
    const binding = {
      async run(_model: unknown, params: unknown) {
        const response = await fetch("https://research-agent-service.test/model", {
          method: "POST",
          body: JSON.stringify(params),
        });
        if (!response.ok) throw new Error("Fixture model boundary rejected the request.");
        const result = await response.json<{
          text?: string;
          tool?: { name: string; input: unknown; id: string };
          tools?: Array<{ name: string; input: unknown; id: string }>;
        }>();
        const selectedTools = result.tools ?? (result.tool ? [result.tool] : []);
        const delta = selectedTools.length
          ? {
              tool_calls: selectedTools.map((selectedTool, index) => ({
                index,
                id: selectedTool.id,
                type: "function",
                function: {
                  name: selectedTool.name,
                  arguments: JSON.stringify(selectedTool.input),
                },
              })),
            }
          : { content: result.text ?? "Fixture final response." };
        const events = [
          { choices: [{ delta, finish_reason: selectedTools.length ? "tool_calls" : "stop" }] },
          { response: "", usage: { prompt_tokens: 12, completion_tokens: 4 } },
        ];
        const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        });
      },
    } as unknown as Ai;

    return observeScopedInferenceUsage(
      requestInferenceStreamUsage(binding),
      () => this.currentResearchModelRequest(),
      async () => {},
    );
  }

  async inspectFixture() {
    return {
      state: this.state,
      submissions: await this.listSubmissions(),
    };
  }
}

export const fixtureIds = { workspaceId, runId, actorId };
export const fixtureScope: ResearchAgentScope = {
  workspaceId,
  runId,
  actorId,
  operationId: "accepted-operation",
  question: "Investigate the latest status.",
  questions: [{ id: "10000000-0000-4000-8000-000000000004", question: "Latest status" }],
  noteId: null,
  personId: null,
  sourceUrls: [],
  discoverSources: true,
  timeframe: { mode: "current" },
};
export const fixturePolicy = researchRunPolicySchema.parse({
  version: "research-v1",
  promptVersion: "research-extract-v2",
  provider: "workers-ai",
  model: "@cf/fixture/research-agent",
  budgetId: "10000000-0000-4000-8000-000000000005",
  rateVersionId: "10000000-0000-4000-8000-000000000006",
  executionVersion: "research-agent-v2",
  maxModelSteps: 8,
  deadlineMs: 60_000,
});

type FixtureEnv = {
  RESEARCH_AGENT: DurableObjectNamespace<ResearchAgent>;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = { workspaceId, runId };
    const agent = env.RESEARCH_AGENT.get(env.RESEARCH_AGENT.idFromName(researchAgentName(key)));
    try {
      if (url.pathname === "/start" || url.pathname === "/start-lost-ack") {
        const result = await agent.startResearchRun(key);
        return url.pathname === "/start-lost-ack"
          ? Response.json({ acknowledgementLost: true }, { status: 503 })
          : Response.json(result ?? null);
      }
      if (url.pathname === "/cancel") {
        await agent.cancelResearchRun(key);
        return Response.json({ cancelled: true });
      }
      if (url.pathname === "/reconcile") {
        await agent.reconcileResearchPublication();
        return Response.json({ reconciled: true });
      }
      if (url.pathname === "/inspect") {
        return Response.json(await Promise.resolve(agent.inspectFixture()));
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<FixtureEnv>;
