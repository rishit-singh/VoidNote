import { assistantPolicySchema, readAssistantPolicy } from "../config/assistant";
import { readResearchPolicy } from "../config/research";
import { pinResearchRunPolicy } from "../config/research-runs";
import type { AssistantSource } from "../contracts/assistant";
import { WorkspaceError } from "../contracts/workspace";
import {
  createAssistantEvidenceRepository,
  createAssistantRepository,
  readAssistantTranscriptEvidence,
} from "../db/assistant";
import { createConversationSummaryRepository } from "../db/conversation-summaries";
import { createInferenceRepository } from "../db/inference";
import { createWorkspaceRepository } from "../db/repository";
import {
  createResearchEvidenceRepository,
  createResearchRepository,
  createResearchRunsRepository,
} from "../db/research";
import { executionTrace } from "../telemetry/execution";
import type { AssistantExecution, AssistantServices } from "./assistant";
import {
  assistantToolNamesForVersion,
  assistantToolSchemas,
  assistantToolSchemasV3,
  assistantToolSchemasV5,
  assistantToolSchemasV6,
} from "./assistant/tools";
import { createAssistantReaders } from "./assistant-context";
import { withJobDatabase } from "./jobs";
import { dispatchResearchItem } from "./research";
import { dispatchResearchRun } from "./research/runs";

function uniqueResearchSources(sources: AssistantSource[]): AssistantSource[] {
  return [
    ...new Map(
      sources.map((source) => [
        JSON.stringify([source.researchRunId, source.researchBatchId, source.id]),
        source,
      ]),
    ).values(),
  ].slice(0, 100);
}

export function createAssistantServices(env: Cloudflare.Env): AssistantServices {
  const repository = <T>(
    work: (repo: ReturnType<typeof createAssistantRepository>) => Promise<T>,
  ) => withJobDatabase(env, (db) => work(createAssistantRepository(db)));

  async function execution(workspaceId: string, turnId: string): Promise<AssistantExecution> {
    const current = await repository((repo) => repo.execution(workspaceId, turnId));

    if (!current) {
      throw new WorkspaceError("not_found", "Conversation is unavailable.");
    }

    return { ...current, policy: assistantPolicySchema.parse(current.policy) };
  }

  function enabled(current: AssistantExecution): boolean {
    const configured = readAssistantPolicy(env);

    return Boolean(
      configured &&
      configured.model === current.policy.model &&
      configured.budgetId === current.policy.budgetId &&
      configured.rateVersionId === current.policy.rateVersionId,
    );
  }

  return {
    execution,
    beginTurn: (workspaceId, turnId) => repository((repo) => repo.beginTurn(workspaceId, turnId)),
    completeTurn: (workspaceId, turnId, completion) =>
      repository((repo) => repo.completeTurn(workspaceId, turnId, completion)),
    failTurn: (workspaceId, turnId, status, error) =>
      repository((repo) => repo.failTurn(workspaceId, turnId, status, error)),
    async cancelTurn(workspaceId, turnId) {
      const current = await execution(workspaceId, turnId);

      return repository((repo) => repo.cancelTurn(current.principal, workspaceId, turnId));
    },
    async isCancelled(workspaceId, turnId) {
      const current = await repository((repo) => repo.execution(workspaceId, turnId));

      return !current || !["queued", "running"].includes(current.turn.status);
    },
    async authorize(expected, scope) {
      const current = await execution(scope.workspaceId, scope.turnId);

      if (
        current.principal.id !== expected.principal.id ||
        current.thread.id !== expected.thread.id ||
        current.turn.id !== expected.turn.id
      ) {
        throw new WorkspaceError("forbidden", "Conversation identity changed.");
      }
    },
    history: (workspaceId, threadId, limit) =>
      repository((repo) => repo.contextHistory(workspaceId, threadId, limit)),
    contextSummary: (workspaceId, threadId) =>
      withJobDatabase(env, (db) =>
        createConversationSummaryRepository(db).contextSummary(workspaceId, threadId),
      ),
    async admitModelRequest(input) {
      const current = await execution(input.workspaceId, input.turnId);

      if (
        !enabled(current) ||
        current.turn.status !== "running" ||
        JSON.stringify(current.policy) !== JSON.stringify(input.policy)
      ) {
        throw new WorkspaceError("conflict", "Assistant admission is no longer active.");
      }

      await withJobDatabase(env, (db) =>
        createInferenceRepository(db).reserve({
          workspaceId: input.workspaceId,
          budgetId: input.policy.budgetId,
          rateVersionId: input.policy.rateVersionId,
          requestId: input.requestId,
          model: input.policy.model,
          inputTokenBound: input.inputTokenBound,
          maxOutputTokens: input.policy.maxOutputTokens,
        }),
      );
    },
    async executeTool(name, value, context) {
      const current = await execution(context.workspaceId, context.turnId);

      if (
        !enabled(current) ||
        current.turn.status !== "running" ||
        current.thread.id !== context.threadId ||
        current.principal.id !== context.principal.id
      ) {
        throw new WorkspaceError("forbidden", "Tool execution is no longer authorized.");
      }

      const readers = createAssistantReaders(env, current.principal, context.workspaceId);

      const usesV6AssistantTools = current.policy.skillVersion === "assistant-skills-v6";

      if (!assistantToolNamesForVersion(current.policy.skillVersion).includes(name)) {
        throw new WorkspaceError("forbidden", "Tool is not available to this pinned turn.");
      }

      const usesV3AssistantTools =
        current.policy.skillVersion === "assistant-skills-v3" ||
        current.policy.skillVersion === "assistant-skills-v4" ||
        current.policy.skillVersion === "assistant-skills-v5" ||
        usesV6AssistantTools;

      const writeContext = { turnId: context.turnId };

      switch (name) {
        case "context_read": {
          const options = usesV6AssistantTools
            ? assistantToolSchemasV6.context_read.parse(value)
            : assistantToolSchemasV5.context_read.parse(value);

          const result = await readers.readContext(
            current.thread.noteId,
            current.policy.maxToolResultBytes,
            true,
            options,
          );

          return {
            summary:
              "Read current conversation context. Use returned coverage and cursors before claiming complete evidence.",
            data: result,
            sources: result.sources,
          };
        }

        case "transcript_read": {
          const input = assistantToolSchemasV6.transcript_read.parse(value);

          let limit = input.limit;

          let result;

          do {
            result = await withJobDatabase(env, (db) =>
              readAssistantTranscriptEvidence(db, current.principal, context.workspaceId, {
                ...input,
                limit,
              }),
            );

            if (
              new TextEncoder().encode(JSON.stringify(result)).byteLength <=
                current.policy.maxToolResultBytes / 2 ||
              limit === 1
            ) {
              break;
            }

            limit = Math.max(1, Math.floor(limit / 2));
          } while (limit >= 1);

          return {
            summary: `Read ${result.passages.length} passages in the requested transcript scope.`,
            data: result,
            sources: result.sources,
          };
        }

        case "research_lookup": {
          const input = assistantToolSchemasV6.research_lookup.parse(value);

          const data = await executionTrace(
            env,
            {
              workspaceId: context.workspaceId,
              turnId: context.turnId,
              actorId: current.principal.id,
            },
            "research.evidence.lookup",
            () =>
              withJobDatabase(env, async (db) => {
                const legacy = await createResearchEvidenceRepository(db).lookup(
                  current.principal,
                  context.workspaceId,
                  input,
                );

                const runs = await createResearchRunsRepository(db).lookup(
                  current.principal,
                  context.workspaceId,
                  {
                    query: input.query,
                    personIds: input.personIds,
                    ...(input.maxAgeDays ? { maxAgeDays: input.maxAgeDays } : {}),
                    limit: Math.min(input.limit, 10),
                    includeActiveRuns: input.includeActive,
                  },
                );

                return {
                  runs,
                  runsCoverage: "bounded-candidates" as const,
                  cursorScope: "saved-contact-research" as const,
                  savedContactResearch: {
                    ...legacy,
                    items: legacy.items.map((item) => ({
                      ...item,
                      findingCount: item.findings.length,
                      findings: item.findings.slice(0, 3).map((finding) => ({
                        key: finding.key,
                        question: finding.question,
                        status: finding.status,
                        answer: finding.answer,
                        citations: finding.citations.map((citation) => ({
                          sourceId: citation.sourceId,
                          url: citation.url,
                          asOf: citation.asOf,
                          retrievedAt: citation.retrievedAt,
                        })),
                      })),
                    })),
                  },
                };
              }),
            { actorType: "assistant", stage: "lookup" },
          );

          await executionTrace(
            env,
            {
              workspaceId: context.workspaceId,
              turnId: context.turnId,
              actorId: current.principal.id,
            },
            "research.evidence.selection",
            () => Promise.resolve(undefined),
            {
              actorType: "assistant",
              candidateCount: data.runs.length + data.savedContactResearch.items.length,
              lookupOutcome:
                data.runs.length || data.savedContactResearch.items.length ? "hit" : "miss",
            },
          );

          return {
            summary: `Found ${data.runs.length} research runs and ${data.savedContactResearch.items.length} saved contact-research matches. Check dates and relevance before reuse.`,
            data,
            sources: uniqueResearchSources(
              data.savedContactResearch.items.flatMap((item) =>
                item.findings.flatMap((finding) =>
                  finding.citations.map((citation) => ({
                    kind: "url" as const,
                    id: citation.sourceId,
                    url: citation.url,
                    researchBatchId: item.batchId,
                    label: finding.question.slice(0, 300),
                  })),
                ),
              ),
            ),
          };
        }

        case "research_get":
        case "research_status": {
          if (name === "research_status" && current.policy.skillVersion !== "assistant-skills-v6") {
            const input = assistantToolSchemas.research_status.parse(value);

            const batch = await withJobDatabase(env, (db) =>
              createResearchRepository(db).get(
                current.principal,
                context.workspaceId,
                input.batchId,
              ),
            );

            const sources: AssistantSource[] = batch.items
              .flatMap((item) =>
                item.findings.flatMap((finding) =>
                  finding.citations.map((citation) => ({
                    kind: "url" as const,
                    id: citation.url,
                    url: citation.url,
                    label: finding.question.slice(0, 300),
                  })),
                ),
              )
              .slice(0, 100);

            return { summary: `Research is ${batch.status}.`, data: batch, sources };
          }

          const input =
            name === "research_status"
              ? {
                  ...assistantToolSchemasV6.research_status.parse(value),
                  section: "status" as const,
                  questionIds: [] as string[],
                  offset: 0,
                  limit: 0,
                }
              : assistantToolSchemasV6.research_get.parse(value);

          if (input.runId) {
            const run = await withJobDatabase(env, (db) =>
              createResearchRunsRepository(db).get(
                current.principal,
                context.workspaceId,
                input.runId!,
              ),
            );

            const matches = run.findings.filter(
              (finding) =>
                input.questionIds.length === 0 || input.questionIds.includes(finding.questionId),
            );

            const findings = matches.slice(input.offset, input.offset + input.limit);

            const nextOffset =
              input.offset + findings.length < matches.length
                ? input.offset + findings.length
                : null;

            const data =
              input.section === "status"
                ? {
                    id: run.id,
                    question: run.question,
                    status: run.status,
                    stage: run.stage,
                    gaps: run.gaps,
                    error: run.error,
                  }
                : {
                    id: run.id,
                    question: run.question,
                    status: run.status,
                    stage: run.stage,
                    ...(input.section === "report" ? { answer: run.report?.answer ?? null } : {}),
                    findings,
                    gaps: run.report?.gaps ?? run.gaps,
                    error: run.error,
                    coverage:
                      nextOffset !== null
                        ? "partial-page"
                        : input.offset
                          ? "final-page"
                          : "complete",
                    nextOffset,
                  };

            return {
              summary: `Research is ${run.status}; stage: ${run.stage}.`,
              data,
              sources:
                input.section === "status"
                  ? []
                  : uniqueResearchSources(
                      findings.flatMap((finding) =>
                        finding.citations.map((citation) => ({
                          kind: "url" as const,
                          id: citation.sourceId,
                          url: citation.url,
                          researchRunId: run.id,
                          label: finding.question.slice(0, 300),
                        })),
                      ),
                    ),
            };
          }

          const batch = await withJobDatabase(env, (db) =>
            createResearchRepository(db).get(
              current.principal,
              context.workspaceId,
              "batchId" in input ? input.batchId! : "",
            ),
          );

          if (input.questionIds.length) {
            throw new WorkspaceError(
              "conflict",
              "Question IDs apply to general research runs, not contact batches.",
            );
          }

          const allFindings = batch.items.flatMap((item) =>
            item.findings.map((finding) => ({ ...finding, personId: item.personId })),
          );

          const findings = allFindings.slice(input.offset, input.offset + input.limit);

          return {
            summary: `Read saved contact research: ${batch.status}.`,
            data: {
              id: batch.id,
              status: batch.status,
              findings,
              nextOffset:
                input.offset + findings.length < allFindings.length
                  ? input.offset + findings.length
                  : null,
            },
            sources: uniqueResearchSources(
              findings.flatMap((finding) =>
                finding.citations.map((citation) => ({
                  kind: "url" as const,
                  id: citation.sourceId,
                  url: citation.url,
                  researchBatchId: batch.id,
                  label: finding.question.slice(0, 300),
                })),
              ),
            ),
          };
        }

        case "research_cancel": {
          const input = assistantToolSchemasV6.research_cancel.parse(value);

          const run = await withJobDatabase(env, (db) =>
            createResearchRunsRepository(db).cancel(
              current.principal,
              context.workspaceId,
              input.runId,
              context.turnId,
            ),
          );

          return {
            summary: `Research is ${run.status}.`,
            data: { id: run.id, status: run.status, stage: run.stage },
            sources: [],
          };
        }

        case "work_list": {
          const input = assistantToolSchemasV6.work_list.parse(value);

          const runs = await withJobDatabase(env, (db) =>
            createResearchRunsRepository(db).list(current.principal, context.workspaceId, {
              ...input,
              threadId: current.thread.id,
            }),
          );

          return {
            summary: `Found ${runs.length} research tasks in this conversation.`,
            data: runs.map((run) => ({
              id: run.id,
              question: run.question,
              status: run.status,
              stage: run.stage,
              error: run.error,
              updatedAt: run.updatedAt,
              href: `/research/${run.id}`,
            })),
            sources: [],
          };
        }

        case "notes_search": {
          let input: {
            q: string;
            limit: number;
            cursor?: string;
            match: "title" | "content" | "title-or-content";
          };

          if (usesV3AssistantTools) {
            const parsed = assistantToolSchemasV3.notes_search.parse(value);

            input = {
              q: parsed.q,
              limit: parsed.limit,
              match: parsed.match,
              ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
            };
          } else {
            const parsed = assistantToolSchemas.notes_search.parse(value);

            input = {
              q: parsed.q,
              limit: parsed.limit,
              match: "title",
              ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
            };
          }

          const result =
            input.match !== "title"
              ? await withJobDatabase(env, (db) =>
                  createAssistantEvidenceRepository(db).searchNotes(
                    current.principal,
                    context.workspaceId,
                    {
                      q: input.q,
                      limit: Math.min(input.limit, 30),
                      match: input.match === "content" ? "content" : "title-or-content",
                      ...(input.cursor ? { cursor: input.cursor } : {}),
                    },
                  ),
                )
              : await withJobDatabase(env, (db) =>
                  createWorkspaceRepository(db).listNotes(current.principal, context.workspaceId, {
                    q: input.q,
                    limit: input.limit,
                    ...(input.cursor ? { cursor: input.cursor } : {}),
                  }),
                );

          return {
            summary: `Found ${result.items.length} authorized workspace notes by ${"match" in result ? "title or content" : "title prefix"}.`,
            data: {
              items: result.items.map((note) => ({
                id: note.id,
                title: note.title,
                revision: note.revision,
              })),
              nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
            },
            sources: result.items.map((note) => ({
              kind: "note" as const,
              id: note.id,
              label: note.title,
              revision: note.revision,
            })),
          };
        }

        case "notes_get": {
          type NoteReadInput = {
            noteId: string;
            section: "authored" | "summary" | "transcript";
            cursor?: string;
            offset?: number;
            length?: number;
          };

          let input: NoteReadInput;

          if (usesV3AssistantTools) {
            const parsed = assistantToolSchemasV3.notes_get.parse(value);

            input = {
              noteId: parsed.noteId,
              section: parsed.section,
              ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
              ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
              length: parsed.length,
            };
          } else {
            const parsed = assistantToolSchemas.notes_get.parse(value);

            input = {
              noteId: parsed.noteId,
              section: "transcript",
              ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
            };
          }

          const result = await readers.readNote(
            input.noteId,
            input.section,
            input.cursor,
            current.policy.maxToolResultBytes,
            "offset" in input ? input.offset : undefined,
            "length" in input ? input.length : undefined,
            current.policy.skillVersion === "assistant-skills-v5",
          );

          return {
            summary: `Read authorized note ${input.section} evidence; coverage is ${"coverage" in result ? result.coverage : "complete"}.`,
            data: result,
            sources: result.sources,
          };
        }

        case "contacts_search": {
          const input = assistantToolSchemas.contacts_search.parse(value);

          const result = await readers.searchContacts(input.q, input.limit, input.cursor);

          return {
            summary: `Found ${result.contacts.length} matching contacts.`,
            data: result,
            sources: result.contacts.map((person) => ({
              kind: "person",
              id: person.id,
              label: person.displayName,
              revision: person.revision,
            })),
          };
        }

        case "contacts_get": {
          const input = assistantToolSchemas.contacts_get.parse(value);

          const result = await readers.getContacts(input.personIds, input.fieldGroups);

          return {
            summary: `Read ${result.length} current saved contacts.`,
            data: result,
            sources: result.map((person) => ({
              kind: "person",
              id: person.id,
              label: person.displayName,
              revision: person.revision,
              contactRevision: person.detailsRevision,
            })),
          };
        }

        case "contacts_create": {
          if (!usesV3AssistantTools) {
            throw new WorkspaceError(
              "forbidden",
              "Profile writes require assistant-skills-v3 or assistant-skills-v4.",
            );
          }

          const input = assistantToolSchemasV3.contacts_create.parse(value);

          const result = await repository((repo) =>
            repo.createProfile(
              current.principal,
              context.workspaceId,
              {
                ...input,
                operationId: context.operationId,
              },
              { turnId: context.turnId, executor: "agent" },
            ),
          );

          return {
            summary: `Created profile ${result.person.displayName} from sourced evidence.`,
            data: result,
            sources: [
              ...result.provenance.sources,
              {
                kind: "person",
                id: result.person.id,
                label: result.person.displayName,
                revision: result.person.revision,
                contactRevision: result.contact.revision,
              },
            ],
          };
        }

        case "contacts_update": {
          if (!usesV3AssistantTools) {
            throw new WorkspaceError(
              "forbidden",
              "Profile writes require assistant-skills-v3 or assistant-skills-v4.",
            );
          }

          const input = assistantToolSchemasV3.contacts_update.parse(value);

          const result = await repository((repo) =>
            repo.updateProfile(
              current.principal,
              context.workspaceId,
              {
                ...input,
                operationId: context.operationId,
              },
              { turnId: context.turnId, executor: "agent" },
            ),
          );

          return {
            summary: `Updated sourced profile fields for ${result.person.displayName}.`,
            data: result,
            sources: [
              ...result.provenance.sources,
              {
                kind: "person",
                id: result.person.id,
                label: result.person.displayName,
                revision: result.person.revision,
                contactRevision: result.contact.revision,
              },
            ],
          };
        }

        case "artifact_create": {
          const input = assistantToolSchemas.artifact_create.parse(value);

          const result = await repository((repo) =>
            repo.createArtifact(
              current.principal,
              context.workspaceId,
              { ...input, operationId: context.operationId },
              writeContext,
            ),
          );

          const source: AssistantSource = {
            kind: "artifact",
            id: result.id,
            label: result.name,
            revision: result.revision,
          };

          return {
            summary: `Saved ${result.kind}: ${result.name}.`,
            data: {
              id: result.id,
              kind: result.kind,
              name: result.name,
              noteId: result.noteId,
              revision: result.revision,
            },
            sources: [source],
          };
        }

        case "artifact_get": {
          const input = assistantToolSchemas.artifact_get.parse(value);

          const artifact = await repository((repo) =>
            repo.getContextArtifact(current.principal, context.workspaceId, input.artifactId),
          );

          const end = Math.min(artifact.content.length, input.offset + input.length);

          return {
            summary: `Read saved ${artifact.kind}: ${artifact.name}.`,
            data: {
              id: artifact.id,
              name: artifact.name,
              kind: artifact.kind,
              content: artifact.content.slice(input.offset, end),
              offset: input.offset,
              nextOffset: end < artifact.content.length ? end : null,
              totalCharacters: artifact.content.length,
            },
            sources: [
              {
                kind: "artifact",
                id: artifact.id,
                label: artifact.name,
                revision: artifact.revision,
              },
            ],
          };
        }

        case "history_search": {
          const input = assistantToolSchemas.history_search.parse(value);

          const limit = Math.min(
            input.limit,
            Math.max(1, Math.floor(current.policy.maxToolResultBytes / 4000)),
          );

          const result = await repository((repo) =>
            repo.retrieveHistory(
              current.principal,
              context.workspaceId,
              context.threadId,
              input.query,
              input.cursor,
              limit,
            ),
          );

          return {
            summary:
              "Retrieved historical messages and saved tool summaries; raw tool payloads are not retained.",
            data: {
              ...result,
              hits: result.hits.map((hit) => ({
                id: hit.id,
                role: hit.role,
                createdAt: hit.createdAt,
                text: hit.text.slice(0, 600),
                textTruncated: hit.textTruncated || hit.text.length > 600,
                tools: hit.tools.slice(0, 2).map((tool) => ({
                  name: tool.name,
                  status: tool.status,
                  summary: tool.summary.slice(0, 200),
                })),
                toolsTruncated: hit.toolsTruncated || hit.tools.length > 2,
              })),
            },
            sources: result.hits.map((hit) => ({
              kind: "message",
              id: hit.id,
              label: `${hit.role} message`,
            })),
          };
        }

        case "memory_recall": {
          const input = assistantToolSchemas.memory_recall.parse(value);

          const result = await repository((repo) =>
            repo.recall(
              current.principal,
              context.workspaceId,
              input.query,
              input.subjectId ?? undefined,
            ),
          );

          return {
            summary: input.query
              ? `Recalled ${Math.min(result.length, input.limit)} active memories matching the literal text ${JSON.stringify(input.query)}. ${
                  result.length === 0
                    ? "No matches does not mean no active memory exists. Try a shorter literal phrase, or an empty query to list active memories."
                    : "This is a filtered search, not a complete inventory of active memories."
                }`
              : `Listed ${Math.min(result.length, input.limit)} active memories.`,
            data: result.slice(0, input.limit),
            sources: result.slice(0, input.limit).map((memory) => ({
              kind: "memory",
              id: memory.id,
              label: memory.kind,
              revision: memory.revision,
            })),
          };
        }

        case "memory_remember": {
          const input = assistantToolSchemas.memory_remember.parse(value);

          const result = await repository((repo) =>
            repo.remember(
              current.principal,
              context.workspaceId,
              { ...input, operationId: context.operationId },
              writeContext,
            ),
          );

          return {
            summary:
              result.status === "active"
                ? "Saved memory with its provenance."
                : "Saved an unverified memory for review.",
            data: result,
            sources:
              result.status === "active"
                ? [{ kind: "memory", id: result.id, label: result.kind, revision: result.revision }]
                : [],
          };
        }

        case "memory_invalidate": {
          const input = assistantToolSchemas.memory_invalidate.parse(value);

          const result = await repository((repo) =>
            repo.invalidateMemory(
              current.principal,
              context.workspaceId,
              input.memoryId,
              input.expectedRevision,
              input.reason,
              context.operationId,
              writeContext,
            ),
          );

          return {
            summary: "Invalidated the memory.",
            data: result,
            sources: [],
            invalidatedSources: [{ kind: "memory", id: input.memoryId }],
          };
        }

        case "memory_revise": {
          const input = assistantToolSchemas.memory_revise.parse(value);

          const result = await repository((repo) =>
            repo.reviseMemory(
              current.principal,
              context.workspaceId,
              input.memoryId,
              input.expectedRevision,
              input.content,
              input.sources,
              input.reason,
              context.operationId,
              writeContext,
            ),
          );

          return {
            summary: "Updated the memory and retained its revision history.",
            data: result,
            invalidatedSources: [{ kind: "memory", id: input.memoryId }],
            sources: [
              { kind: "memory", id: result.id, label: result.kind, revision: result.revision },
            ],
          };
        }

        case "research_dispatch": {
          if (usesV6AssistantTools) {
            const input = assistantToolSchemasV6.research_dispatch.parse(value);

            const configured = readResearchPolicy(env);

            const run = await withJobDatabase(env, (db) =>
              createResearchRunsRepository(db).request(
                current.principal,
                {
                  ...input,
                  workspaceId: context.workspaceId,
                  commandId: context.operationId,
                  noteId: input.noteId === undefined ? current.thread.noteId : input.noteId,
                },
                configured && env.RESEARCH_RUN_WORKFLOW
                  ? pinResearchRunPolicy(
                      configured,
                      env.RESEARCH_AGENT_ENABLED === "true"
                        ? "research-workflow-v3"
                        : "workflow-v1",
                    )
                  : null,
                context.turnId,
              ),
            );

            if (run.status === "queued") {
              await Promise.allSettled([
                dispatchResearchRun(env, { workspaceId: context.workspaceId, runId: run.id }),
              ]);
            }

            return {
              summary: `Research accepted; current status is ${run.status}.`,
              data: {
                id: run.id,
                status: run.status,
                question: run.question,
                href: `/research/${run.id}`,
              },
              sources: [],
            };
          }

          const input = assistantToolSchemas.research_dispatch.parse(value);

          const batch = await withJobDatabase(env, (db) =>
            createResearchRepository(db).request(
              current.principal,
              {
                workspaceId: context.workspaceId,
                requestId: context.operationId,
                people: input.people,
              },
              readResearchPolicy(env),
              writeContext,
            ),
          );

          // Acceptance is already durable. Failed acceleration is reconciled by
          // the scheduled dispatcher, never represented as failed acceptance.
          await Promise.allSettled(
            batch.items
              .filter((item) => item.status === "queued")
              .map((item) =>
                dispatchResearchItem(env, {
                  workspaceId: context.workspaceId,
                  batchId: batch.id,
                  personId: item.personId,
                  generation: item.generation,
                }),
              ),
          );

          return {
            summary: `Research ${batch.status}; findings are not ready until published.`,
            data: batch,
            sources: [],
          };
        }

        default:
          throw new WorkspaceError("conflict", "This assistant tool is unavailable.");
      }
    },
  };
}
