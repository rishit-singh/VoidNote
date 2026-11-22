import type * as SummaryService from "../../src/ai/summary/service";

// Only the persistence/context boundary is replaced. Requests are intercepted
// in-process by Miniflare; no database, R2, or external service is contacted.
async function call<T>(operation: string, args: unknown[]): Promise<T> {
  const response = await fetch(`https://summary-service.test/${operation}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    if (response.headers.get("x-fixture-terminal-outage") === "true") {
      // Reach the real Workflow's terminal failure path without its production
      // multi-minute retry policy. Only the service failure is simulated.
      throw new NonRetryableError("Fixture terminal persistence outage");
    }
    throw new Error(`Fixture service rejected ${operation}`);
  }
  return response.json<T>();
}

export const getSummaryExecution: typeof SummaryService.getSummaryExecution = (_env, ...args) =>
  call("execution", args);

export const prepareSummaryContext: typeof SummaryService.prepareSummaryContext = (_env, ...args) =>
  call("prepare", args);

export const loadSummaryPrompt: typeof SummaryService.loadSummaryPrompt = (_env, ...args) =>
  call("prompt", args);

export const publishSummary: typeof SummaryService.publishSummary = (_env, ...args) =>
  call("publish", args);

export const failSummary: typeof SummaryService.failSummary = (_env, ...args) => call("fail", args);
import { NonRetryableError } from "cloudflare:workflows";
