import { assistantAgentName } from "../../src/ai/assistant/agent";
import { readAssistantOutputText } from "../../src/ai/assistant/output";
import { assistantOutputScopeSchema } from "../../src/contracts/assistant/output";
import { AssistantAgent as RuntimeFixture } from "./assistant-runtime.fixture";

export class AssistantAgent extends RuntimeFixture {
  async codecFixture() {
    const streamId = this._resumableStream.start("codec-fixture");
    const store = (chunk: unknown) =>
      this._resumableStream.storeChunk(streamId, JSON.stringify(chunk));
    store({ type: "text-delta", id: "one", delta: "First" });
    this._resumableStream.flushBuffer();
    store({ type: "reasoning-delta", id: "private", delta: "PRIVATE reasoning" });
    store({
      type: "tool-input-available",
      toolCallId: "secret",
      input: { query: "PRIVATE input" },
    });
    store({
      type: "tool-output-available",
      toolCallId: "secret",
      output: { text: "PRIVATE result" },
    });
    store({ type: "text-delta", id: "two", delta: "Second" });
    this._resumableStream.flushBuffer();
    const read = () =>
      readAssistantOutputText(
        {
          streams: this.streams,
          inspect: () => Promise.resolve({ requestId: "codec-fixture" }),
          streamInfo: (requestId) => this._resumableStream.latestStreamInfoForRequest(requestId),
          flush: () => this._resumableStream.flushBuffer(),
          message: () => Promise.resolve(null),
        },
        new AbortController().signal,
      );
    const text = await read();
    store({ type: "text-delta", id: "two", delta: "x".repeat(70_000) });
    const bounded = await read();

    return { text, boundedLength: bounded?.length };
  }

  override getAIBinding(): Ai {
    return {
      async run() {
        const response = await fetch("https://assistant-service.test/model");
        if (!response.ok || !response.body) throw new Error("Fixture model unavailable.");

        return response.body;
      },
    } as unknown as Ai;
  }
}

type Environment = { ASSISTANT_AGENT: DurableObjectNamespace<AssistantAgent> };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const scope = assistantOutputScopeSchema.parse({
      workspaceId: url.searchParams.get("workspaceId"),
      threadId: url.searchParams.get("threadId"),
      turnId: url.searchParams.get("turnId"),
    });
    const name = assistantAgentName(scope);
    const agent = env.ASSISTANT_AGENT.get(env.ASSISTANT_AGENT.idFromName(name));
    try {
      switch (url.pathname) {
        case "/codec":
          return Response.json(await agent.codecFixture());
        case "/lease":
          return Response.json(
            await agent.createOutputLease({
              ...scope,
              actorId: url.searchParams.get("actorId") ?? scope.workspaceId,
            }),
          );
        case "/output":
          return new Response(
            await agent.openAcceptedTurnOutput({
              ...scope,
              ticket: url.searchParams.get("ticket") ?? "",
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          );
        case "/start":
          return Response.json(
            await agent.startTurn({ workspaceId: scope.workspaceId, turnId: scope.turnId }),
          );
        case "/export":
          return Response.json(
            await agent.retryExport({ workspaceId: scope.workspaceId, turnId: scope.turnId }),
          );
        case "/cancel":
          await agent.cancelTurn({ workspaceId: scope.workspaceId, turnId: scope.turnId });

          return Response.json(null);
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch {
      return new Response("Unavailable", { status: 403 });
    }
  },
} satisfies ExportedHandler<Environment>;
