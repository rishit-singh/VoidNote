import { MockLanguageModelV4 } from "ai/test";

export function summaryModel() {
  return new MockLanguageModelV4({
    provider: "local-summary-fixture",
    modelId: "deterministic-structured-tool",
    async doStream(options) {
      const tool = options.tools?.find(
        (candidate) => candidate.type === "function" && candidate.name === "think_final_answer",
      );
      if (!tool) throw new Error("Think did not inject its structured final-answer tool");
      const response = await fetch("https://summary-service.test/model", {
        method: "POST",
        body: JSON.stringify({
          tools: options.tools,
          toolChoice: options.toolChoice,
          prompt: options.prompt,
        }),
      });
      if (!response.ok) throw new Error("Fixture model boundary rejected the request");
      const output = await response.json();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "fixture-final-answer",
              toolName: "think_final_answer",
              input: JSON.stringify(output),
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: {
                inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 30, text: 30, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  });
}
