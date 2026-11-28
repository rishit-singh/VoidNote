import { activityHubName } from "../../src/contracts/activity";
import { ActivityHub } from "../../src/events/activity-hub";
import { activityOutputResponse } from "../../src/events/activity-output";

export { ActivityHub };

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const url = new URL(request.url);
    const hub = env.ACTIVITY_HUB.getByName(
      activityHubName(url.searchParams.get("workspaceId")!, url.searchParams.get("userId")!),
    );
    if (url.pathname === "/ticket") return Response.json(await hub.issueTicket());
    if (url.pathname === "/publish") {
      await hub.publish();
      return Response.json({ published: true });
    }
    return activityOutputResponse(request, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
