import { createHash } from "node:crypto";

import type { ContextReference } from "./schema";
import { contextReferenceSchema } from "./schema";
import { validateSummaryContext } from "./validation";

type SnapshotReader = {
  get(key: string): Promise<{ size: number; text(): Promise<string> } | null>;
};

// Shared by background execution and authorized historical-citation reads.
// Callers establish current access before loading this immutable private object.
export async function readSummarySnapshot(
  bucket: SnapshotReader,
  workspaceId: string,
  jobId: string,
  input: ContextReference,
  maxContextBytes: number,
) {
  const reference = contextReferenceSchema.parse(input);
  const expectedKey = `analysis/${workspaceId}/${jobId}/context-${reference.checksum}.json`;

  if (reference.snapshotId !== jobId || reference.objectKey !== expectedKey) {
    throw new Error("Context reference does not belong to this job.");
  }

  const object = await bucket.get(reference.objectKey);

  if (!object || object.size > maxContextBytes) {
    throw new Error("Context snapshot is missing or exceeds its pinned budget.");
  }

  const body = await object.text();
  const checksum = createHash("sha256").update(body).digest("hex");

  if (
    checksum !== reference.checksum ||
    new TextEncoder().encode(body).byteLength > maxContextBytes
  ) {
    throw new Error("Context snapshot failed integrity validation.");
  }

  const context = validateSummaryContext(JSON.parse(body) as unknown);

  if (
    context.workspaceId !== workspaceId ||
    context.snapshotId !== reference.snapshotId ||
    JSON.stringify(context.source) !== JSON.stringify(reference.source) ||
    context.noteRevision !== reference.noteRevision ||
    JSON.stringify(context.people.map(({ personId, revision }) => ({ personId, revision }))) !==
      JSON.stringify(reference.profiles)
  ) {
    throw new Error("Context snapshot does not belong to this job.");
  }

  return context;
}
