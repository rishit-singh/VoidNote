import { AsyncLocalStorage } from "node:async_hooks";
import { trace } from "@opentelemetry/api";
import { ZodError } from "zod";
import { WorkspaceError } from "../contracts/workspace";
import type { ResearchExtractionFailureCode } from "../ai/research";

type Scope = {
  workspaceId: string;
  turnId?: string;
  jobId?: string;
  batchId?: string;
  personId?: string;
  requestId?: string;
  runId?: string;
  questionId?: string;
  actorId?: string;
  originTurnId?: string;
  generation?: number;
};
type Details = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  failureCode?:
    ResearchExtractionFailureCode | "invalid_evidence" | "invalid_report" | "provider_error";
  stage?: string;
  promptVersion?: string;
  policyVersion?: string;
  actorType?: "user" | "assistant" | "workflow" | "reconciliation";
  finishReason?: string;
  candidateCount?: number;
  selectedSourceCount?: number;
  reusedSourceCount?: number;
  sourceBytes?: number;
  contextBytes?: number;
  answeredQuestionCount?: number;
  rejectedQuestionCount?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  lookupOutcome?: "hit" | "miss" | "stale" | "unknown";
};

type Attribute = {
  key: string;
  value: { stringValue: string } | { intValue: string };
};
type RecordedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: number };
};
type Context = {
  traceId: string;
  spanId: string;
  batch: { spans: RecordedSpan[]; closed: boolean };
  ended: boolean;
};

// One context per actual invocation, never a persisted span or a global current job.
const executions = new AsyncLocalStorage<Context>();
const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const operation = /^[a-z][a-z0-9_.-]{0,79}$/;
const MAX_SPANS = 256;
const MAX_ERROR_CAUSES = 5;
const EXPORT_TIMEOUT_MS = 800;

function id(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function text(key: string, value: string): Attribute {
  return { key, value: { stringValue: value } };
}

function identifiers(scope: Scope): Attribute[] {
  return Object.entries(scope).flatMap(([key, value]) => {
    if (key === "generation" && Number.isSafeInteger(value) && Number(value) > 0) {
      return [{ key: "voidnote.generation", value: { intValue: String(value) } }];
    }
    if (
      ![
        "workspaceId",
        "turnId",
        "jobId",
        "batchId",
        "personId",
        "requestId",
        "runId",
        "questionId",
        "actorId",
        "originTurnId",
      ].includes(key) ||
      typeof value !== "string" ||
      !uuid.test(value)
    ) {
      return [];
    }
    const field = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    return [text(`voidnote.${field}`, value)];
  });
}

/** Stable categories only: provider/database messages may contain source content. */
function errorType(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error instanceof WorkspaceError) return "WorkspaceError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof ZodError) return "ZodError";
  if (error instanceof DOMException && error.name === "AbortError") return "AbortError";
  if (error instanceof DOMException && error.name === "TimeoutError") return "TimeoutError";
  return "Error";
}

const workspaceErrorCodes = new Set(["forbidden", "not_found", "conflict", "invalid_cursor"]);

/** Export only bounded exception metadata; never messages or arbitrary properties. */
function safeCauseAttributes(error: unknown): Attribute[] {
  const attributes = new Map<string, Attribute>();
  const seen = new Set<object>();
  let current: unknown = error;
  let causeCount = 0;
  while (current instanceof Error && causeCount < MAX_ERROR_CAUSES) {
    let cause: unknown;
    try {
      cause = Reflect.get(current, "cause");
    } catch {
      break;
    }
    if ((typeof cause !== "object" && typeof cause !== "function") || cause === null) break;
    if (seen.has(cause)) break;
    seen.add(cause);
    causeCount += 1;

    try {
      if (cause instanceof Error) {
        attributes.set(
          "voidnote.error.cause_type",
          text("voidnote.error.cause_type", errorType(cause)),
        );
      }
      if (cause instanceof WorkspaceError && workspaceErrorCodes.has(cause.code)) {
        attributes.set(
          "voidnote.error.domain_code",
          text("voidnote.error.domain_code", cause.code),
        );
      }
      const code: unknown = Reflect.get(cause, "code");
      if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) {
        attributes.set("db.sqlstate", text("db.sqlstate", code));
      }
    } catch {
      // Ignore exotic property accessors; diagnostics must never change domain behavior.
    }
    current = cause;
  }
  return [...attributes.values()];
}

function config(env: unknown): { endpoint: string; token: string; environment?: string } | null {
  if (typeof env !== "object" || env === null) return null;
  const token: unknown = Reflect.get(env, "LOGFIRE_TOKEN");
  const base: unknown = Reflect.get(env, "LOGFIRE_BASE_URL");
  if (typeof token !== "string" || !token.trim() || typeof base !== "string") return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    const environment: unknown = Reflect.get(env, "LOGFIRE_ENVIRONMENT");
    return {
      endpoint: new URL("/v1/traces", url).href,
      token: token.trim(),
      ...(typeof environment === "string" &&
      ["development", "staging", "production"].includes(environment)
        ? { environment }
        : {}),
    };
  } catch {
    return null;
  }
}

async function send(env: unknown, spans: RecordedSpan[]): Promise<void> {
  const target = config(env);
  if (!target) return;
  try {
    const response = await fetch(target.endpoint, {
      method: "POST",
      headers: { authorization: target.token, "content-type": "application/json" },
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                text("service.name", "voidnote"),
                ...(target.environment
                  ? [text("deployment.environment.name", target.environment)]
                  : []),
              ],
            },
            scopeSpans: [{ scope: { name: "voidnote.execution", version: "1" }, spans }],
          },
        ],
      }),
    });
    // Never read collector response content or let cancellation delay domain work.
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Telemetry failure must not turn successful paid work into a retry.
  }
}

/**
 * Actual nested operations share a trace and parent. Replayed/detached durable
 * invocations get new roots, correlated by stable product IDs, never fake parents.
 * Only bounded identifiers/categories are exported, never arguments or results.
 */
export async function executionTrace<T>(
  env: unknown,
  scope: Scope,
  name: string,
  work: () => Promise<T>,
  details: Details = {},
): Promise<T> {
  if (!uuid.test(scope.workspaceId) || !operation.test(name) || !config(env)) return work();
  const inherited = executions.getStore();
  const parent = inherited?.ended ? undefined : inherited;
  const external = trace.getActiveSpan()?.spanContext();
  const context: Context = {
    traceId: parent?.traceId ?? (external?.traceFlags ? external.traceId : id(16)),
    spanId: id(8),
    batch: parent?.batch ?? { spans: [], closed: false },
    ended: false,
  };
  const parentSpanId = parent?.spanId ?? (external?.traceFlags ? external.spanId : undefined);
  const attributes = identifiers(scope);
  if (details.failureCode && /^[a-z_]{1,60}$/.test(details.failureCode)) {
    attributes.push(text("voidnote.failure_code", details.failureCode));
  }
  if (name === "research.workflow" || name === "research.run.workflow") {
    attributes.push(
      text("gen_ai.operation.name", "invoke_agent"),
      text("gen_ai.agent.name", "VoidNote Research"),
    );
  } else if (name.startsWith("assistant.tool.")) {
    attributes.push(
      text("gen_ai.operation.name", "execute_tool"),
      text("gen_ai.tool.name", name.slice("assistant.tool.".length)),
    );
  }
  if (details.model && /^@cf\/[a-zA-Z0-9._/-]{1,120}$/.test(details.model)) {
    attributes.push(text("gen_ai.request.model", details.model));
  }
  for (const [key, value] of [
    ["gen_ai.usage.input_tokens", details.inputTokens],
    ["gen_ai.usage.output_tokens", details.outputTokens],
    ["gen_ai.usage.cache_read.input_tokens", details.cachedInputTokens],
    ["gen_ai.usage.reasoning.output_tokens", details.reasoningTokens],
    ["voidnote.candidate_count", details.candidateCount],
    ["voidnote.selected_source_count", details.selectedSourceCount],
    ["voidnote.reused_source_count", details.reusedSourceCount],
    ["voidnote.source_bytes", details.sourceBytes],
    ["voidnote.context_bytes", details.contextBytes],
    ["voidnote.answered_question_count", details.answeredQuestionCount],
    ["voidnote.rejected_question_count", details.rejectedQuestionCount],
  ] as const) {
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0) {
      attributes.push({ key, value: { intValue: String(value) } });
    }
  }
  for (const [key, value] of [
    ["voidnote.stage", details.stage],
    ["voidnote.prompt_version", details.promptVersion],
    ["voidnote.policy_version", details.policyVersion],
    ["voidnote.actor_type", details.actorType],
    ["voidnote.lookup_outcome", details.lookupOutcome],
    ["gen_ai.response.finish_reason", details.finishReason],
  ] as const) {
    if (typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)) {
      attributes.push(text(key, value));
    }
  }
  const started = Date.now();
  let failed = Boolean(details.failureCode);
  return executions.run(context, async () => {
    try {
      const result = await work();
      if (typeof result === "object" && result !== null && "status" in result) {
        const status = result.status;
        if (
          typeof status === "string" &&
          [
            "queued",
            "running",
            "succeeded",
            "completed",
            "partial",
            "failed",
            "uncertain",
            "blocked",
            "interrupted",
            "cancelled",
            "needs-input",
          ].includes(status)
        ) {
          attributes.push(text("voidnote.result_status", status));
          failed ||= ["failed", "uncertain", "blocked", "interrupted", "needs-input"].includes(
            status,
          );
        }
      }
      if (typeof result === "object" && result !== null && "quality" in result) {
        const quality = result.quality;
        if (
          typeof quality === "string" &&
          ["answered", "partial", "conflicting", "insufficient-evidence"].includes(quality)
        ) {
          attributes.push(text("voidnote.result_quality", quality));
        }
      }
      return result;
    } catch (error) {
      failed = true;
      attributes.push(text("error.type", errorType(error)));
      if (error instanceof WorkspaceError && workspaceErrorCodes.has(error.code)) {
        attributes.push(text("voidnote.error.domain_code", error.code));
      }
      attributes.push(...safeCauseAttributes(error));
      throw error;
    } finally {
      context.ended = true;
      if (
        context.batch.closed ||
        context.batch.spans.length < (parent ? MAX_SPANS - 1 : MAX_SPANS)
      ) {
        const span: RecordedSpan = {
          traceId: context.traceId,
          spanId: context.spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name,
          kind: 1,
          startTimeUnixNano: `${BigInt(started) * 1_000_000n}`,
          endTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
          attributes: [...attributes, text("voidnote.outcome", failed ? "error" : "ok")],
          status: { code: failed ? 2 : 1 },
        };
        if (context.batch.closed) {
          // A child that outlives its initiating RPC is exported when it finishes.
          await send(env, [span]);
        } else {
          context.batch.spans.push(span);
        }
      }
      if (!parent) {
        context.batch.closed = true;
        await send(env, context.batch.spans);
      }
    }
  });
}

/** Instrument a port's methods without serializing inputs or changing its contract. */
export function tracedOperations<T extends object>(
  env: unknown,
  scope: Scope,
  prefix: string,
  port: T,
): T {
  return new Proxy(port, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || typeof key !== "string") return value;
      const name = `${prefix}.${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      return (...args: unknown[]) =>
        executionTrace(env, scope, name, () => {
          const result: unknown = Reflect.apply(value, target, args);
          return Promise.resolve(result);
        });
    },
  });
}
