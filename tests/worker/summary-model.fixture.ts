// Only the Workers AI binding is replaced. The production adapter parses this
// raw SSE response, including its handling of missing provider usage.
export function summaryBinding(request: () => unknown): Ai {
  return {
    async run() {
      const response = await fetch("https://summary-service.test/model", {
        method: "POST",
        body: JSON.stringify(request()),
      });
      if (!response.ok) throw new Error("Fixture model boundary rejected the request");
      const missingUsage = response.headers.get("x-fixture-missing-usage") === "true";
      const outputLimit = response.headers.get("x-fixture-output-limit") === "true";
      const output = await response.json();
      // Native Workers AI: per-delta counts, zero-usage choices heartbeat,
      // cumulative { response: "", usage } tail, then [DONE] and clean EOF.
      // Missing final usage still includes deltas, which cannot settle a hold.
      const events = [
        {
          choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }],
          usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
        },
        ...(outputLimit
          ? [
              {
                choices: [
                  { delta: { role: "assistant", content: "partial" }, finish_reason: "length" },
                ],
                usage: { prompt_tokens: 20, completion_tokens: 8192, total_tokens: 8212 },
              },
            ]
          : [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "summary-final-answer",
                          type: "function",
                          function: {
                            name: "think_final_answer",
                            arguments: JSON.stringify(output),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: { prompt_tokens: 0, completion_tokens: 30, total_tokens: 30 },
              },
            ]),
        { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
        ...(outputLimit
          ? [
              {
                response: "",
                usage: { prompt_tokens: 20, completion_tokens: 8192, total_tokens: 8212 },
              },
            ]
          : []),
        ...(missingUsage || outputLimit
          ? []
          : [
              {
                response: "",
                usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
              },
            ]),
      ];
      const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    },
  } as unknown as Ai;
}
