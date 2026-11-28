import type * as SummaryService from "../../src/ai/summary/service";
import { validateSummaryContext } from "../../src/ai/context";
import { interpretSummaryOutput } from "../../src/ai/summary/output";

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

export const reserveSummaryInference: typeof SummaryService.reserveSummaryInference = (
  _env,
  ...args
) => call("reserve", args);

export const settleSummaryInference: typeof SummaryService.settleSummaryInference = (
  _env,
  ...args
) => call("settle", args);

export const prepareSummaryContext: typeof SummaryService.prepareSummaryContext = (_env, ...args) =>
  call("prepare", args);

export const loadSummaryPrompt: typeof SummaryService.loadSummaryPrompt = (_env, ...args) =>
  call("prompt", args);

export const publishSummary: typeof SummaryService.publishSummary = async (_env, ...args) => {
  const [workspaceId, jobId, reference, input] = args;
  const job = await getSummaryExecution(_env, workspaceId, jobId);
  const context = validateSummaryContext(await call("context", [workspaceId, jobId]));
  // Retain the production output validator/projection; only persistence and
  // snapshot retrieval are substituted in this Worker fixture.
  const analysis = interpretSummaryOutput(job.policy.promptVersion, input, context);
  return call("publish", [workspaceId, jobId, reference, analysis]);
};

export const failSummary: typeof SummaryService.failSummary = (_env, ...args) => call("fail", args);
import { NonRetryableError } from "cloudflare:workflows";
