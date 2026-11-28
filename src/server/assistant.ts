import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { readAssistantPolicy } from "@/config/assistant";
import type { AssistantOutputScope } from "@/contracts/assistant";
import type { Principal } from "@/contracts/workspace";

export function createAssistantOutputLease(principal: Principal, scope: AssistantOutputScope) {
  const { env } = getCloudflareContext();

  const agent = env.ASSISTANT_AGENT.get(
    env.ASSISTANT_AGENT.idFromName(`assistant-${scope.workspaceId}-${scope.threadId}`),
  );

  return agent.createOutputLease({ ...scope, actorId: principal.id });
}

export function assistantPolicy() {
  return readAssistantPolicy(getCloudflareContext().env);
}

export function notifyAssistantTurn(
  workspaceId: string,
  threadId: string,
  turnId: string,
  cancel = false,
) {
  const { env, ctx } = getCloudflareContext();

  const work = Promise.resolve().then(async () => {
    const agent = env.ASSISTANT_AGENT.get(
      env.ASSISTANT_AGENT.idFromName(`assistant-${workspaceId}-${threadId}`),
    );

    if (cancel) {
      await agent.cancelTurn({ workspaceId, turnId });
    } else {
      await agent.startTurn({ workspaceId, turnId });
    }
  });

  ctx.waitUntil(
    work.catch(() => {
      console.warn("Assistant runtime notification deferred", { workspaceId, threadId, turnId });
    }),
  );
}
