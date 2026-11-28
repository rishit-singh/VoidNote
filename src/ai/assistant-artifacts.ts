import type { AssistantArtifactPublication } from "../db/assistant";
import { createAssistantRepository } from "../db/assistant";
import { withJobDatabase } from "./jobs";

type PublicationPorts = {
  write(item: AssistantArtifactPublication): Promise<void>;
  acknowledge(item: AssistantArtifactPublication): Promise<boolean>;
  remove(item: AssistantArtifactPublication): Promise<void>;
};

export async function publishAssistantArtifacts(
  pending: AssistantArtifactPublication[],
  ports: PublicationPorts,
) {
  let published = 0;
  let deferred = 0;

  for (const item of pending) {
    try {
      await ports.write(item);

      if (await ports.acknowledge(item)) {
        published += 1;
      } else {
        // A concurrent cancellation/deletion fences publication. Nothing exposes
        // these object keys publicly; remove the losing write.
        await ports.remove(item);
      }
    } catch {
      deferred += 1;
    }
  }

  return { published, deferred };
}

export async function dispatchAssistantArtifacts(
  env: Pick<Cloudflare.Env, "HYPERDRIVE" | "RECORDING_ARTIFACTS">,
) {
  const cleanup = await withJobDatabase(env, (db) =>
    createAssistantRepository(db).pendingArtifactDeletions(20),
  );

  await Promise.allSettled(cleanup.map((item) => env.RECORDING_ARTIFACTS.delete(item.objectKey)));

  const pending = await withJobDatabase(env, (db) =>
    createAssistantRepository(db).pendingArtifactPublications(20),
  );

  return publishAssistantArtifacts(pending, {
    async write(item) {
      await env.RECORDING_ARTIFACTS.put(item.objectKey, item.content, {
        httpMetadata: { contentType: item.mediaType, cacheControl: "private, no-store" },
        customMetadata: { checksum: item.checksum },
      });
    },
    acknowledge: (item) =>
      withJobDatabase(env, (db) =>
        createAssistantRepository(db).acknowledgeArtifactPublication(
          item.workspaceId,
          item.artifactId,
          item.checksum,
        ),
      ),
    remove: (item) => env.RECORDING_ARTIFACTS.delete(item.objectKey),
  });
}
