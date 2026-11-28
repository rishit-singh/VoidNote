/**
 * Privacy-bounded, explicit OTLP export for Summary work outside HTTP requests.
 *
 * Each invocation emits an independent span. Matching deterministic trace IDs
 * provide correlation only; no parent/child relationship is implied across
 * Durable Object, Workflow, or retry boundaries.
 */
export type SummaryTelemetryScope = {
  workspaceId: string;
  jobId: string;
  workflowId?: string;
  snapshotId?: string;
  resultId?: string;
};

export type SummaryUsage = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  responseTimeMs?: number;
  stepTimeMs?: number;
  timeToFirstOutputMs?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  confidence?: "provider" | "inferred";
};

export type SummaryStage =
  | "agent.initialize"
  | "agent.start"
  | "agent.reserve"
  | "request.accept"
  | "workflow.run"
  | "workflow.prepare"
  | "workflow.generate"
  | "workflow.publish"
  | "workflow.complete"
  | "workflow.fail"
  | "model.usage";

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number };
type OtlpAttribute = { key: string; value: OtlpValue };

const EXPORT_TIMEOUT_MS = 800;
const MAX_USAGE_DURATION_MS = 10 * 60 * 1_000;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const WORKFLOW_ID_PATTERN =
  /^summary-[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}-[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const STAGES = new Set<SummaryStage>([
  "agent.initialize",
  "agent.start",
  "agent.reserve",
  "request.accept",
  "workflow.run",
  "workflow.prepare",
  "workflow.generate",
  "workflow.publish",
  "workflow.complete",
  "workflow.fail",
  "model.usage",
]);
const ENVIRONMENTS = new Set(["development", "staging", "production"]);
const WORKERS_AI_MODEL_PATTERN = /^@cf\/[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

function readString(env: unknown, key: string): string | undefined {
  if (typeof env !== "object" || env === null || !(key in env)) return undefined;
  const value: unknown = Reflect.get(env, key);
  return typeof value === "string" ? value : undefined;
}

function exportConfig(env: unknown): { endpoint: string; token: string } | undefined {
  const token = readString(env, "LOGFIRE_TOKEN")?.trim();
  const baseUrl = readString(env, "LOGFIRE_BASE_URL")?.trim();
  if (!token || !baseUrl) return undefined;

  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
      return undefined;
    }
    return { endpoint: new URL("/v1/traces", base).href, token };
  } catch {
    return undefined;
  }
}

function safeScope(scope: SummaryTelemetryScope): OtlpAttribute[] | undefined {
  if (!UUID_PATTERN.test(scope.workspaceId) || !UUID_PATTERN.test(scope.jobId)) return undefined;
  if (scope.workflowId !== undefined && !WORKFLOW_ID_PATTERN.test(scope.workflowId))
    return undefined;
  if (scope.snapshotId !== undefined && !UUID_PATTERN.test(scope.snapshotId)) return undefined;
  if (scope.resultId !== undefined && !UUID_PATTERN.test(scope.resultId)) return undefined;

  const ids: Array<[string, string | undefined]> = [
    ["voidnote.workspace_id", scope.workspaceId],
    ["voidnote.job_id", scope.jobId],
    ["voidnote.workflow_id", scope.workflowId],
    ["voidnote.snapshot_id", scope.snapshotId],
    ["voidnote.result_id", scope.resultId],
  ];
  return ids.flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value: { stringValue: value } }],
  );
}

function validUsage(usage: SummaryUsage | undefined): OtlpAttribute[] {
  if (!usage) return [];
  const modelAttributes =
    typeof usage.model === "string" && WORKERS_AI_MODEL_PATTERN.test(usage.model)
      ? [{ key: "gen_ai.request.model", value: { stringValue: usage.model } }]
      : [];
  const tokenAttributes = (
    [
      ["gen_ai.usage.input_tokens", usage.inputTokens],
      ["gen_ai.usage.output_tokens", usage.outputTokens],
      ["gen_ai.usage.cached_input_tokens", usage.cachedInputTokens],
      ["gen_ai.usage.reasoning_tokens", usage.reasoningTokens],
    ] as const
  ).flatMap(([key, value]) =>
    Number.isSafeInteger(value) && value !== undefined && value >= 0
      ? [{ key, value: { intValue: String(value) } }]
      : [],
  );
  const durationAttributes = (
    [
      ["voidnote.model.response_time_ms", usage.responseTimeMs],
      ["voidnote.model.step_time_ms", usage.stepTimeMs],
      ["voidnote.model.time_to_first_output_ms", usage.timeToFirstOutputMs],
    ] as const
  ).flatMap(([key, value]) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_USAGE_DURATION_MS
      ? [{ key, value: { doubleValue: value } }]
      : [],
  );
  return [...modelAttributes, ...tokenAttributes, ...durationAttributes];
}

function safeFinishReason(value: unknown): OtlpAttribute[] {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,40}$/.test(value)
    ? [{ key: "voidnote.model.finish_reason", value: { stringValue: value } }]
    : [];
}

function safeDiagnosticConfidence(value: unknown): OtlpAttribute[] {
  return value === "provider" || value === "inferred"
    ? [{ key: "voidnote.model.diagnostic_confidence", value: { stringValue: value } }]
    : [];
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deterministicTraceId(scope: SummaryTelemetryScope): Promise<string> {
  const input = new TextEncoder().encode(
    `voidnote.summary.trace.v1:${scope.workspaceId}:${scope.jobId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", input);
  const id = hex(new Uint8Array(digest).slice(0, 16));
  return id === "0".repeat(32) ? `1${id.slice(1)}` : id;
}

/** Return the stable W3C trace ID used to correlate Summary operation spans. */
export async function summaryTraceId(scope: SummaryTelemetryScope): Promise<string | undefined> {
  if (!safeScope(scope)) return undefined;
  try {
    return await deterministicTraceId(scope);
  } catch {
    return undefined;
  }
}

function spanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = hex(bytes);
  return id === "0".repeat(16) ? `1${id.slice(1)}` : id;
}

function nanos(epochMs: number): string {
  return (BigInt(epochMs) * 1_000_000n).toString();
}

function cancelResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  const body = response.body;
  if (!body || signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void body.cancel().then(finish, finish);
  });
}

async function exportSpan(env: unknown, span: Record<string, unknown>): Promise<void> {
  const config = exportConfig(env);
  if (!config) return;
  const environment = readString(env, "LOGFIRE_ENVIRONMENT");

  try {
    const signal = AbortSignal.timeout(EXPORT_TIMEOUT_MS);
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        // Match the existing Workers SDK's Logfire exporter configuration.
        authorization: config.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "voidnote" } },
                { key: "service.namespace", value: { stringValue: "summary" } },
                ...(environment && ENVIRONMENTS.has(environment)
                  ? [{ key: "deployment.environment.name", value: { stringValue: environment } }]
                  : []),
              ],
            },
            scopeSpans: [
              {
                scope: { name: "voidnote.summary", version: "1" },
                spans: [span],
              },
            ],
          },
        ],
      }),
      signal,
    });
    // Do not parse collector responses (which may contain arbitrary content).
    // Canceling releases the body stream for success and non-success statuses.
    await cancelResponseBody(response, signal);
  } catch {
    // Export is best-effort: never log exporter errors or alter domain outcomes.
  }
}

/**
 * Trace one Summary operation as an independent span. The callback's result is
 * returned unchanged, including thrown errors. Only explicitly selected fields
 * are exported; callback values and exception details are never inspected.
 */
export async function summaryTrace<T>(
  env: unknown,
  scope: SummaryTelemetryScope,
  stage: SummaryStage,
  work: () => T | Promise<T>,
  usage?: SummaryUsage,
): Promise<T> {
  const identifiers = safeScope(scope);
  if (!identifiers || !STAGES.has(stage)) return await work();

  const started = Date.now();
  let outcome: "ok" | "error" = "ok";
  let result: T;
  try {
    result = await work();
  } catch (error) {
    outcome = "error";
    const attributes = [
      ...identifiers,
      { key: "voidnote.stage", value: { stringValue: stage } },
      { key: "voidnote.outcome", value: { stringValue: outcome } },
      {
        key: "voidnote.duration_ms",
        value: { intValue: String(Math.max(0, Date.now() - started)) },
      },
    ];
    await safelyExport(env, scope, stage, started, attributes);
    throw error;
  }

  const attributes = [
    ...identifiers,
    { key: "voidnote.stage", value: { stringValue: stage } },
    { key: "voidnote.outcome", value: { stringValue: outcome } },
    { key: "voidnote.duration_ms", value: { intValue: String(Math.max(0, Date.now() - started)) } },
    ...validUsage(usage),
    ...(usage ? safeFinishReason(usage.finishReason) : []),
    ...(usage ? safeDiagnosticConfidence(usage.confidence) : []),
  ];
  await safelyExport(env, scope, stage, started, attributes);
  return result;
}

async function safelyExport(
  env: unknown,
  scope: SummaryTelemetryScope,
  stage: SummaryStage,
  started: number,
  attributes: OtlpAttribute[],
): Promise<void> {
  try {
    const traceId = await deterministicTraceId(scope);
    await exportSpan(env, {
      traceId,
      spanId: spanId(),
      // Deliberately no parentSpanId: independent durable executions/replays.
      name: `summary ${stage}`,
      kind: 1,
      startTimeUnixNano: nanos(started),
      endTimeUnixNano: nanos(Date.now()),
      attributes,
      status: {
        code: attributes.some(
          (item) =>
            item.key === "voidnote.outcome" &&
            "stringValue" in item.value &&
            item.value.stringValue === "error",
        )
          ? 2
          : 1,
      },
    });
  } catch {
    // Includes unexpected crypto/runtime/export failures; domain work wins.
  }
}

/** Export a bounded numeric usage measurement as a Summary span. */
export async function emitSummaryUsage(
  env: unknown,
  scope: SummaryTelemetryScope,
  usage: SummaryUsage,
): Promise<void> {
  await summaryTrace(env, scope, "model.usage", () => undefined, usage);
}
