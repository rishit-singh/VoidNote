import { z } from "zod";
import type { ProcessingParams } from "../contracts/recording-processing";

// Narrow service ports keep Worker runtime globals out of the web TypeScript
// target. The Worker entrypoint itself uses Wrangler-generated CloudflareEnv.
// These are the operations the application adapter consumes, not a second Env.
export interface StoredArtifact {
  size: number;
  httpEtag: string;
  checksums: { sha256?: ArrayBuffer };
  body?: ReadableStream<Uint8Array>;
  range?: { offset?: number; length?: number; suffix?: number };
}
export interface ArtifactBucket {
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<StoredArtifact | null>;
  get(key: string, options?: { range: Headers }): Promise<StoredArtifact | null>;
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: { sha256: string; onlyIf: Headers; httpMetadata: { contentType: string } },
  ): Promise<StoredArtifact | null>;
}
export interface ProcessingWorkflowBinding {
  createBatch(options: { instances: { id: string; params: ProcessingParams }[] }): Promise<{
    created: { id: string }[];
    errors: { index: number; id?: string; code: number; message: string }[];
  }>;
  get(id: string): Promise<{ status(): Promise<{ status: string }>; restart(): Promise<void> }>;
}
const methods = (value: unknown, names: string[]) =>
  typeof value === "object" &&
  value !== null &&
  names.every((name) => typeof Reflect.get(value, name) === "function");
export const recordingBindingsSchema = z.object({
  RECORDING_ARTIFACTS: z.custom<ArtifactBucket>((value) => methods(value, ["head", "get", "put"])),
  PROCESS_RECORDING: z.custom<ProcessingWorkflowBinding>((value) =>
    methods(value, ["createBatch", "get"]),
  ),
  PYANNOTE_API_KEY: z.string().optional(),
  RECORDING_CAPABILITY_SECRET: z.string().min(32),
});
