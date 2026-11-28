import { tool } from "ai";

import type {
  ResearchAgentScope,
  ResearchAgentServices,
  ResearchAgentToolContext,
} from "../../../contracts/research/execution";
import {
  researchWorkflowFindingBatchInputSchema,
  researchWorkflowLookupInputSchema,
  researchWorkflowReadInputSchema,
  researchWorkflowRetrieveInputSchema,
  researchWorkflowSearchInputSchema,
} from "../../../contracts/research/workflow";

const MAX_EXTERNAL_CONCURRENCY = 2;

type WorkflowToolName =
  "evidence_lookup" | "evidence_read" | "search_sources" | "retrieve_source" | "record_findings";

type ToolContext = {
  toolCallId: string;
};

function uuidFromDigest(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function researchWorkflowOperationId(identity: readonly unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(identity)),
  );

  return uuidFromDigest(new Uint8Array(digest).slice(0, 16));
}

function createSemaphore(limit: number) {
  let active = 0;

  const waiters: Array<() => void> = [];

  return async function withPermit<T>(work: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }

    active += 1;

    try {
      return await work();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  };
}

async function mapBounded<T, R>(
  values: T[],
  limit: number,
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);

  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;

        results[index] = await work(values[index]!, index);
      }
    }),
  );

  return results;
}

export function createResearchWorkflowTools(
  services: ResearchAgentServices,
  scope: ResearchAgentScope,
  withExternalPermit: <T>(work: () => Promise<T>) => Promise<T> = createSemaphore(
    MAX_EXTERNAL_CONCURRENCY,
  ),
  onUncertain: () => void = () => {},
  retainEvidenceText: (text: string) => Promise<string> = (text) => Promise.resolve(text),
) {
  async function execute(
    name: WorkflowToolName,
    input: unknown,
    context: ResearchAgentToolContext,
  ) {
    try {
      return await services.executeTool(name, input, context);
    } catch (error) {
      onUncertain();
      throw error;
    }
  }

  async function contextFor(toolCallId: string, index = 0): Promise<ResearchAgentToolContext> {
    return {
      ...scope,
      operationId: await researchWorkflowOperationId([
        "research-workflow-v3-tool",
        scope.workspaceId,
        scope.runId,
        toolCallId,
        index,
      ]),
    };
  }

  async function boundEvidenceResult(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => boundEvidenceResult(item)));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const record = value as Record<string, unknown>;

    if (record.ok !== true || typeof record.text !== "string") {
      return value;
    }

    const text = await retainEvidenceText(record.text);

    const result: Record<string, unknown> = { ...record, text };

    if (text.length < record.text.length) {
      result.endOffset =
        typeof record.startOffset === "number" ? record.startOffset + text.length : text.length;
      result.nextOffset = result.endOffset;
      result.truncated = true;
      result.evidenceBudgetExhausted = true;
    }

    return result;
  }

  return {
    evidence_lookup: tool({
      description: "Find eligible saved evidence and inspect its freshness.",
      inputSchema: researchWorkflowLookupInputSchema,
      execute: async (input: { query: string; limit: number }, { toolCallId }: ToolContext) =>
        execute("evidence_lookup", input, await contextFor(toolCallId)),
    }),
    evidence_read: tool({
      description: "Read up to six exact, bounded passages from authorized evidence snapshots.",
      inputSchema: researchWorkflowReadInputSchema,
      execute: async (
        input: { reads: Array<{ sourceId: string; startOffset: number; limit: number }> },
        { toolCallId }: ToolContext,
      ) => {
        const results = await mapBounded(
          input.reads,
          MAX_EXTERNAL_CONCURRENCY,
          async (read, index) =>
            execute("evidence_read", read, await contextFor(toolCallId, index)),
        );

        return boundEvidenceResult(results);
      },
    }),
    search_sources: tool({
      description:
        "Search up to four focused queries. Results are candidates, not evidence, until retrieved.",
      inputSchema: researchWorkflowSearchInputSchema,
      execute: async (input: { queries: string[] }, { toolCallId }: ToolContext) =>
        mapBounded(input.queries, MAX_EXTERNAL_CONCURRENCY, async (query, index) => {
          const context = await contextFor(toolCallId, index);

          return withExternalPermit(() => execute("search_sources", { query }, context));
        }),
    }),
    retrieve_sources: tool({
      description: "Retrieve up to six public URLs into immutable authorized snapshots.",
      inputSchema: researchWorkflowRetrieveInputSchema,
      execute: async (input: { urls: string[] }, { toolCallId }: ToolContext) => {
        const results = await mapBounded(
          input.urls,
          MAX_EXTERNAL_CONCURRENCY,
          async (url, index) => {
            const context = await contextFor(toolCallId, index);

            return withExternalPermit(() => execute("retrieve_source", { url }, context));
          },
        );

        return boundEvidenceResult(results);
      },
    }),
    record_findings: tool({
      description: "Save a draft batch of question findings and evidence gaps.",
      inputSchema: researchWorkflowFindingBatchInputSchema,
      execute: async (
        input: { findings: unknown[]; gaps: string[] },
        { toolCallId }: ToolContext,
      ) => execute("record_findings", input, await contextFor(toolCallId)),
    }),
  };
}
