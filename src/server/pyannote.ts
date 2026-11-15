import { z } from "zod";
import type { NormalizedTurn } from "../db/recording-repository";

const statusSchema = z.enum(["pending", "created", "running", "succeeded", "failed", "canceled"]);
const jobSchema = z.object({ jobId: z.string().min(1).max(200), status: statusSchema });
const turnSchema = z
  .object({
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    speaker: z.string().max(200),
    text: z.string().max(100_000),
  })
  .refine((turn) => turn.end >= turn.start);
const resultSchema = jobSchema.extend({
  status: z.literal("succeeded"),
  output: z.object({
    turnLevelTranscription: z.array(turnSchema).max(10_000),
    error: z.string().optional(),
  }),
});

export class ProviderRequestError extends Error {
  readonly ambiguous: boolean;
  readonly status: number | undefined;
  constructor(ambiguous: boolean, status?: number) {
    super(
      ambiguous
        ? "Provider submission outcome is unknown. Await its callback; do not submit again."
        : `Provider request rejected${status ? ` (${status})` : ""}.`,
    );
    this.ambiguous = ambiguous;
    this.status = status;
  }
}

// Shared bounded reader: provider bodies and stored raw results cannot exhaust
// Worker memory. Raw bytes are persisted before normalization/publication.
export async function boundedJSON(
  response: Response,
  maxBytes = 8 * 1024 * 1024,
): Promise<{ raw: string; data: unknown }> {
  if (!response.body) throw new Error("Provider response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Provider result exceeds the supported size.");
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
    return { raw, data: JSON.parse(raw) as unknown };
  } finally {
    reader.releaseLock();
  }
}

export function normalizePyannote(data: unknown, jobId: string): NormalizedTurn[] {
  const result = resultSchema.parse(data);
  if (result.jobId !== jobId || result.output.error)
    throw new Error("Provider result does not match a successful transcription.");
  return result.output.turnLevelTranscription;
}

export function pyannote(key: string, fetcher: typeof fetch = fetch) {
  if (!key) throw new Error("PYANNOTE_API_KEY is not configured.");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return {
    async submit(audioUrl: string, webhook: string) {
      let response: Response;
      try {
        response = await fetcher("https://api.pyannote.ai/v1/diarize", {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            url: audioUrl,
            webhook,
            webhookStatusOnly: true,
            model: "precision-3",
            transcription: true,
            transcriptionConfig: { model: "parakeet-tdt-0.6b-v3" },
          }),
        });
      } catch {
        throw new ProviderRequestError(true);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderRequestError(
          response.status >= 500 || response.status === 408,
          response.status,
        );
      }
      try {
        return jobSchema.parse((await boundedJSON(response, 64 * 1024)).data);
      } catch {
        throw new ProviderRequestError(true);
      }
    },
    async getState(jobId: string) {
      const response = await fetcher(
        `https://api.pyannote.ai/v1/jobs/${encodeURIComponent(jobId)}`,
        { headers, signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Provider status request failed (${response.status}).`);
      }
      const result = await boundedJSON(response);
      const state = jobSchema.parse(result.data);
      if (state.jobId !== jobId) throw new Error("Provider returned another job.");
      return { ...state, ...result };
    },
    getResult: normalizePyannote,
  };
}
