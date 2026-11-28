import { z } from "zod";

import { ACTIVITY_PROTOCOL, activityHubName } from "../contracts/activity";

const scopeSchema = z.object({ workspaceId: z.uuid(), userId: z.uuid() }).strict();

export async function activityOutputResponse(
  request: Request,
  env: Pick<Cloudflare.Env, "APP_URL" | "ACTIVITY_HUB">,
) {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required.", { status: 426 });
  }
  const url = new URL(request.url);
  let origin: string;
  try {
    origin = new URL(env.APP_URL).origin;
  } catch {
    return new Response("Activity unavailable.", { status: 503 });
  }
  if (
    request.headers.get("origin") !== origin ||
    url.origin !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return new Response("Request not allowed.", { status: 403 });
  }
  const scope = scopeSchema.safeParse(Object.fromEntries(url.searchParams));
  const protocols = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((part) => part.trim());
  if (
    !scope.success ||
    protocols?.length !== 2 ||
    protocols[0] !== ACTIVITY_PROTOCOL ||
    !/^[a-f0-9]{64}$/.test(protocols[1]!)
  ) {
    return new Response("Invalid activity subscription.", { status: 400 });
  }
  const hub = env.ACTIVITY_HUB.getByName(
    activityHubName(scope.data.workspaceId, scope.data.userId),
  );
  return hub.fetch(request);
}
