import {
  ASSISTANT_OUTPUT_LEASE_MS,
  ASSISTANT_OUTPUT_PROTOCOL,
  assistantOutputFrameSchema,
  assistantOutputScopeSchema,
} from "../contracts/assistant";
import { assistantAgentName } from "./assistant";

const MAX_FRAME_BYTES = 512_000;
const MAX_LEASE_OUTPUT_BYTES = 2_000_000;

/** A bounded read-only bridge, never the native Agent router or submission API. */
export async function assistantOutputResponse(
  request: Request,
  env: Pick<Cloudflare.Env, "ASSISTANT_AGENT" | "APP_URL">,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required.", { status: 426 });
  }

  let appOrigin: string;

  try {
    appOrigin = new URL(env.APP_URL).origin;
  } catch {
    return new Response("Output subscription unavailable.", { status: 503 });
  }

  if (
    request.headers.get("origin") !== appOrigin ||
    request.headers.get("origin") !== url.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return new Response("Request not allowed.", { status: 403 });
  }

  const scope = assistantOutputScopeSchema.safeParse(Object.fromEntries(url.searchParams));
  const protocols = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((part) => part.trim());
  const ticket = protocols?.[1];

  if (
    !scope.success ||
    protocols?.length !== 2 ||
    protocols[0] !== ASSISTANT_OUTPUT_PROTOCOL ||
    !ticket ||
    !/^[a-f0-9]{64}$/.test(ticket)
  ) {
    return new Response("Invalid output subscription.", { status: 400 });
  }

  let stream: ReadableStream<Uint8Array>;

  try {
    const agent = env.ASSISTANT_AGENT.get(
      env.ASSISTANT_AGENT.idFromName(assistantAgentName(scope.data)),
    );

    stream = await agent.openAcceptedTurnOutput({ ...scope.data, ticket });
  } catch {
    return new Response("Output subscription unavailable.", { status: 403 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const reader = stream.getReader();

  server.accept();

  let closed = false;
  const stop = (code: number) => {
    if (closed) {
      return;
    }

    closed = true;
    server.close(code, "Output subscription closed.");
    void reader.cancel().catch(() => {});
  };

  server.addEventListener("message", () => stop(1008));
  server.addEventListener("close", () => stop(1000));
  server.addEventListener("error", () => stop(1011));
  const deadline = setTimeout(() => stop(1000), ASSISTANT_OUTPUT_LEASE_MS);

  ctx.waitUntil(
    (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      let sentBytes = 0;

      try {
        for (;;) {
          const chunk = await reader.read();

          if (chunk.done || closed) {
            break;
          }

          if (chunk.value.byteLength > MAX_FRAME_BYTES) {
            throw new Error("Oversized output frame");
          }

          pending += decoder.decode(chunk.value, { stream: true });

          if (pending.length > MAX_FRAME_BYTES) {
            throw new Error("Oversized output frame");
          }

          let boundary: number;

          while ((boundary = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, boundary);
            pending = pending.slice(boundary + 1);

            if (!line) {
              continue;
            }

            const frame = assistantOutputFrameSchema.parse(JSON.parse(line));

            if (frame.turnId !== scope.data.turnId || closed) {
              throw new Error("Output scope changed");
            }

            const encoded = JSON.stringify(frame);
            sentBytes += new TextEncoder().encode(encoded).byteLength;

            if (sentBytes > MAX_LEASE_OUTPUT_BYTES) {
              throw new Error("Output subscription byte limit reached");
            }

            server.send(encoded);

            if (frame.type === "terminal") {
              return;
            }
          }
        }
      } catch {
        stop(1011);
      } finally {
        clearTimeout(deadline);
        stop(1000);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    })(),
  );

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      "Sec-WebSocket-Protocol": ASSISTANT_OUTPUT_PROTOCOL,
      "Cache-Control": "private, no-store",
    },
  });
}
