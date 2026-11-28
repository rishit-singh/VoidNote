import { z } from "zod";

import {
  AssistantAgent as ApplicationAssistantAgent,
  assistantAgentName,
} from "../../src/ai/assistant/agent";
import type { AssistantServices, AssistantTurnInput } from "../../src/ai/assistant/services";
import { WorkspaceError } from "../../src/contracts/workspace";

async function invoke<T>(operation: string, args: unknown[]): Promise<T> {
  const response = await fetch(`https://assistant-service.test/${operation}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    const workspaceCode = response.headers.get("x-fixture-workspace-code");
    if (workspaceCode) {
      const code = z
        .enum([
          "forbidden",
          "not_found",
          "conflict",
          "invalid_cursor",
          "command_reused",
          "service_unavailable",
        ])
        .parse(workspaceCode);
      throw new WorkspaceError(code, await response.text());
    }
    const error = new Error("Fixture service unavailable.");
    const code = response.headers.get("x-fixture-error-code");
    if (code) Object.assign(error, { code });
    throw error;
  }

  return response.json<T>();
}

export class AssistantAgent extends ApplicationAssistantAgent {
  protected override createServices(): AssistantServices {
    const services: AssistantServices = {
      execution: (...args) => invoke("execution", args),
      beginTurn: (...args) => invoke("beginTurn", args),
      completeTurn: (...args) => invoke("completeTurn", args),
      failTurn: (...args) => invoke("failTurn", args),
      cancelTurn: (...args) => invoke("cancelTurn", args),
      isCancelled: (...args) => invoke("isCancelled", args),
      authorize: (...args) => invoke("authorize", args),
      history: (...args) => invoke("history", args),
      executeTool: (...args) => invoke("executeTool", args),
      admitModelRequest: (...args) => invoke("admitModelRequest", args),
    };
    if (Reflect.get(this.env, "ASSISTANT_TEST_CONTEXT_SUMMARY") === "true") {
      services.contextSummary = (...args) => invoke("contextSummary", args);
    }

    return services;
  }

  override getAIBinding(): Ai {
    return {
      async run(_model: unknown, params: unknown) {
        const reply = await invoke<{
          text?: string;
          tool?: { name: string; input: unknown; id?: string };
          tools?: Array<{ name: string; input: unknown; id: string }>;
        }>("model", [params]);
        const tools = reply.tools ?? (reply.tool ? [reply.tool] : []);
        const delta = tools.length
          ? {
              tool_calls: tools.map((entry, index) => ({
                index,
                id: entry.id ?? "fixture-tool-1",
                type: "function",
                function: { name: entry.name, arguments: JSON.stringify(entry.input) },
              })),
            }
          : { content: reply.text ?? "Hello! How can I help?" };
        const events = [
          { choices: [{ delta, finish_reason: tools.length ? "tool_calls" : "stop" }] },
          { response: "", usage: { prompt_tokens: 30, completion_tokens: 10 } },
        ];
        const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;

        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        });
      },
    } as unknown as Ai;
  }

  async inspectFixture(): Promise<string> {
    return JSON.stringify({ state: this.state, submissions: await this.listSubmissions() });
  }

  async recoverFixture() {
    return this.onChatRecovery();
  }
}

type FixtureEnvironment = {
  ASSISTANT_AGENT: DurableObjectNamespace<AssistantAgent>;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const input: AssistantTurnInput = {
      workspaceId: url.searchParams.get("workspaceId")!,
      turnId: url.searchParams.get("turnId")!,
    };
    const threadId = z.uuid().parse(url.searchParams.get("threadId"));
    const name = assistantAgentName({ workspaceId: input.workspaceId, threadId });
    const agent = env.ASSISTANT_AGENT.get(env.ASSISTANT_AGENT.idFromName(name));
    try {
      switch (url.pathname) {
        case "/start":
          return Response.json(await agent.startTurn(input));
        case "/cancel":
          await agent.cancelTurn(input);

          return Response.json({ cancelled: true });
        case "/inspect":
          return new Response(await agent.inspectFixture(), {
            headers: { "content-type": "application/json" },
          });
        case "/export":
          return Response.json(await agent.retryExport(input));
        case "/recover":
          return Response.json(await agent.recoverFixture());
        case "/reconcile":
          await agent.reconcileAssistantExport();

          return Response.json(null);
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<FixtureEnvironment>;
