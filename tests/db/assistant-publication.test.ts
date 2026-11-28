import assert from "node:assert/strict";
import { test } from "node:test";

import { publishAssistantArtifacts } from "../../src/ai/assistant-artifacts";
import type { AssistantArtifactPublication } from "../../src/db/assistant";

const item: AssistantArtifactPublication = {
  workspaceId: "workspace",
  artifactId: "artifact",
  objectKey: "private/file",
  checksum: "checksum",
  content: "Authored content",
  mediaType: "text/plain",
};

void test("publication retries identical bytes after an uncertain SQL acknowledgement", async () => {
  const writes: AssistantArtifactPublication[] = [];
  let attempts = 0;
  const ports = {
    write(value: AssistantArtifactPublication) {
      writes.push(value);
      return Promise.resolve();
    },
    acknowledge() {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("SQL unavailable"));
      }
      return Promise.resolve(true);
    },
    remove() {
      assert.fail("Uncertain acknowledgement must preserve the private object");
    },
  };

  assert.deepEqual(await publishAssistantArtifacts([item], ports), { published: 0, deferred: 1 });
  assert.deepEqual(await publishAssistantArtifacts([item], ports), { published: 1, deferred: 0 });
  assert.deepEqual(writes, [item, item]);
});

void test("a cancellation that wins publication removes the losing object", async () => {
  const events: string[] = [];
  const result = await publishAssistantArtifacts([item], {
    write() {
      events.push("write");
      return Promise.resolve();
    },
    acknowledge() {
      events.push("cancelled");
      return Promise.resolve(false);
    },
    remove() {
      events.push("remove");
      return Promise.resolve();
    },
  });

  assert.deepEqual(events, ["write", "cancelled", "remove"]);
  assert.deepEqual(result, { published: 0, deferred: 0 });
});
