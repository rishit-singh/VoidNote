import "server-only";

import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";

/** Fixed operation names keep user content out of telemetry. */
type Operation = "GET /api/health" | "check health";

async function withSpan<T>(
  operation: Operation,
  requestId: string,
  work: () => T | Promise<T>,
): Promise<T> {
  let span: Span;
  try {
    span = trace.getTracer("voidnote").startSpan(
      operation,
      {
        kind: operation === "GET /api/health" ? SpanKind.SERVER : SpanKind.INTERNAL,
        attributes: { "voidnote.operation": operation, "request.id": requestId },
      },
      // The smoke request is its own root; framework spans are not exported.
      operation === "GET /api/health" ? ROOT_CONTEXT : context.active(),
    );
  } catch {
    // Telemetry initialization must never prevent application work.
    return work();
  }

  try {
    return await context.with(trace.setSpan(context.active(), span), work);
  } catch (error) {
    // Exceptions may contain provider tokens, note text or audio metadata.
    // Record only the failure status and preserve the original application error.
    try {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // A telemetry failure must not replace the application error.
    }
    throw error;
  } finally {
    try {
      span.end();
    } catch {
      // Export/processor failures must not change the application result.
    }
  }
}

export function traceHealthRequest<T>(requestId: string, work: () => T | Promise<T>): Promise<T> {
  return withSpan("GET /api/health", requestId, work);
}

export function traceHealthService<T>(requestId: string, work: () => T | Promise<T>): Promise<T> {
  return withSpan("check health", requestId, work);
}
