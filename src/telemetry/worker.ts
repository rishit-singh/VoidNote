import { instrument, type PostProcessorFn, type TraceConfig } from "@pydantic/otel-cf-workers";

function readString(env: unknown, key: string): string | undefined {
  if (typeof env !== "object" || env === null || !(key in env)) return undefined;
  const value: unknown = Reflect.get(env, key);
  return typeof value === "string" ? value : undefined;
}

function traceEndpoint(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return new URL("/v1/traces", url).href;
  } catch {
    return undefined;
  }
}

// Export only our two explicit smoke spans. Framework/Worker instrumentation can
// contain URLs, queries, binding values and exception messages; none are exported.
const sanitizeSpans: PostProcessorFn = (spans) =>
  spans.flatMap((span) => {
    const operation = span.attributes["voidnote.operation"];
    if (operation !== "GET /api/health" && operation !== "check health") return [];
    const requestId = span.attributes["request.id"];
    const { traceId, spanId, traceFlags } = span.spanContext();
    return [
      {
        ...span,
        name: operation,
        attributes: {
          ...(typeof requestId === "string" ? { "request.id": requestId } : {}),
        },
        status: { code: span.status.code },
        events: [],
        links: [],
        duration: span.duration,
        spanContext: () => ({ traceId, spanId, traceFlags }),
      },
    ];
  });

function configuration(env: unknown): TraceConfig {
  const token = readString(env, "LOGFIRE_TOKEN")?.trim();
  const endpoint = traceEndpoint(readString(env, "LOGFIRE_BASE_URL"));
  const enabled = Boolean(token && endpoint);
  const environment = readString(env, "LOGFIRE_ENVIRONMENT");

  return {
    service: { name: "voidnote" },
    ...(environment === "development" || environment === "staging" || environment === "production"
      ? { environment }
      : {}),
    exporter:
      token && endpoint
        ? { url: endpoint, headers: { Authorization: token } }
        : {
            // OpenTelemetry ExportResultCode.SUCCESS is 0. No network or console output.
            export: (_spans, callback) => callback({ code: 0 }),
            shutdown: () => Promise.resolve(),
          },
    sampling: {
      tailSampler: ({ spans }) =>
        enabled &&
        spans.some((span) => span.attributes["voidnote.operation"] === "GET /api/health"),
    },
    instrumentation: { instrumentGlobalFetch: false, instrumentGlobalCache: false },
    handlers: { fetch: { acceptTraceContext: false } },
    postProcessor: sanitizeSpans,
  };
}

/**
 * Call once in the custom Worker entrypoint around OpenNext's generated handler.
 * The SDK registers one provider per isolate and flushes each request's own
 * processors through ctx.waitUntil(). Do not also register a Node/Vercel SDK.
 */
export function instrumentWorker<Env>(handler: ExportedHandler<Env>): ExportedHandler<Env> {
  // instrument mutates its argument; preserve the generated OpenNext handler.
  return instrument({ ...handler }, configuration);
}
