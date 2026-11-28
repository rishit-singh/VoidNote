import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";

/** Names originate in registered application handlers, never raw request URLs. */
export async function traceOperation<T>(name: string, work: () => Promise<T>): Promise<T> {
  let span: Span;
  try {
    span = trace
      .getTracer("voidnote")
      .startSpan(name, { attributes: { "voidnote.operation": name } });
  } catch {
    return work();
  }
  try {
    const result = await context.with(trace.setSpan(context.active(), span), work);
    try {
      if (result instanceof Response) {
        span.setAttribute("http.response.status_code", result.status);
        if (result.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      }
    } catch {
      // Instrumentation must preserve the response.
    }
    return result;
  } catch (error) {
    try {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // Preserve the domain error even if the telemetry provider fails.
    }
    throw error;
  } finally {
    try {
      span.end();
    } catch {
      // Export failures must not turn completed mutations into retries.
    }
  }
}
