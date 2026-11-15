import { traceHealthRequest, traceHealthService } from "@/telemetry/spans";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // Generate locally rather than trusting a caller-controlled header.
  const requestId = crypto.randomUUID();
  return traceHealthRequest(requestId, async () => {
    const result = await traceHealthService(requestId, () => ({ status: "ok" }));
    return Response.json(
      { ...result, requestId },
      { headers: { "x-request-id": requestId, "cache-control": "no-store" } },
    );
  });
}
