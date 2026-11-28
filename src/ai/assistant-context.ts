import { and, eq } from "drizzle-orm";

import type { AssistantSource } from "../contracts/assistant";
import { personListSchema } from "../contracts/people";
import { correctedTranscriptPageSchema } from "../contracts/transcript-corrections";
import { type Principal, WorkspaceError } from "../contracts/workspace";
import { createAnalysisRepository } from "../db/analysis";
import { createContactRepository } from "../db/contacts";
import { createRecordingRepository } from "../db/recording-repository";
import { createWorkspaceRepository } from "../db/repository";
import { processingRuns } from "../db/schema";
import { createTranscriptCorrectionRepository } from "../db/transcript-correction-repository";
import { assistantModelEvidence } from "./assistant/evidence";
import { withJobDatabase } from "./jobs";

type Environment = { HYPERDRIVE: { connectionString: string } };

export const ASSISTANT_TRANSCRIPT_PAGE_SIZE = 100;
export type AssistantContextOptions = {
  sections?: Array<"identity" | "note" | "transcript">;
};

export function nextAssistantTranscriptPageSize(current: number): number {
  return Math.max(1, Math.floor(current / 2));
}

export function assistantTranscriptCoverage(
  nextCursor: string | null,
  cursor: string | undefined,
): "partial-page" | "final-page" | "complete" {
  if (nextCursor) {
    return "partial-page";
  }

  return cursor ? "final-page" : "complete";
}

export function assistantEvidenceBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assistantNoteSource(note: {
  id: string;
  title: string;
  revision: number;
}): AssistantSource {
  return {
    kind: "note",
    id: note.id,
    label: note.title,
    revision: note.revision,
  };
}

// These are application query operations, callable by model tools or other jobs.
// Authorization happens on every operation; model context is never an ACL cache.
export function createAssistantReaders(
  env: Environment,
  principal: Principal,
  workspaceId: string,
) {
  return {
    async readContext(
      noteId: string | null,
      maxResultBytes = 24_000,
      compact = false,
      options: AssistantContextOptions = {},
    ) {
      const explicitSelection = options.sections !== undefined;
      const selectedSections = new Set(options.sections ?? ["identity", "note", "transcript"]);
      const sectionMetadata = explicitSelection
        ? {
            includedSections: [...selectedSections],
            omittedSections: (["identity", "note", "transcript"] as const).filter(
              (section) => !selectedSections.has(section),
            ),
          }
        : {};
      const includeIdentity = selectedSections.has("identity");
      const includeNote = selectedSections.has("note");
      const includeTranscript = selectedSections.has("transcript");
      const self = includeIdentity
        ? await withJobDatabase(env, (db) =>
            createWorkspaceRepository(db).getSelfProfile(principal, workspaceId),
          )
        : null;
      const currentUser = self
        ? {
            personId: self.id,
            displayName: self.displayName,
            description: self.description.slice(0, 600),
            descriptionTruncated: self.description.length > 600,
          }
        : null;
      const selfSources: AssistantSource[] = self
        ? [
            {
              kind: "person",
              id: self.id,
              label: `Your profile · ${self.displayName}`,
              revision: self.revision,
            },
          ]
        : [];

      if (!noteId) {
        return {
          ...(includeIdentity ? { currentUser } : {}),
          ...(includeNote ? { note: null } : {}),
          ...(includeTranscript ? { transcript: null } : {}),
          sources: selfSources,
          ...sectionMetadata,
          ...(!noteId
            ? {
                unavailable:
                  "No note is open. Search saved notes or contacts when the request needs them.",
              }
            : {}),
        };
      }

      if (!includeNote && !includeTranscript) {
        return {
          ...(includeIdentity ? { currentUser } : {}),
          sources: selfSources,
          ...sectionMetadata,
        };
      }

      // Reuse the same authorized, revision-bearing readers as explicit tools.
      // Leave room for the outer tool envelope and duplicated source lineage.
      const sectionBudget = Math.floor(maxResultBytes / 4);
      const [note, transcript] = await Promise.all([
        includeNote
          ? this.readNote(noteId, "authored", undefined, sectionBudget, 0, 2000, compact)
          : null,
        includeTranscript
          ? this.readMeetingEvidence(noteId, undefined, sectionBudget, compact)
          : null,
      ]);

      return {
        ...(includeIdentity ? { currentUser } : {}),
        ...(includeNote ? { note } : {}),
        ...(includeTranscript ? { transcript } : {}),
        sources: [...(note?.sources ?? []), ...(transcript?.sources ?? []), ...selfSources],
        ...sectionMetadata,
      };
    },

    async searchContacts(query: string, limit = 10, cursor?: string) {
      const result = personListSchema.parse(
        await withJobDatabase(env, (db) =>
          createWorkspaceRepository(db).listPeople(principal, workspaceId, {
            q: query,
            limit: Math.min(30, Math.max(1, limit)),
            ...(cursor ? { cursor } : {}),
          }),
        ),
      );

      return {
        contacts: result.items.map((person) => ({
          id: person.id,
          displayName: person.displayName,
          descriptionPreview: person.descriptionPreview,
          revision: person.revision,
        })),
        nextCursor: result.nextCursor,
        match: "display-name-prefix",
      };
    },

    async getContacts(ids: string[], groups: string[]) {
      const contacts = await withJobDatabase(env, (db) =>
        createContactRepository(db).getMany(principal, workspaceId, ids),
      );

      return contacts.map((person) => ({
        id: person.personId,
        displayName: person.displayName,
        revision: person.personRevision,
        detailsRevision: person.revision,
        ...(groups.includes("professional")
          ? {
              organization: person.organization,
              role: person.role,
              description: person.description.slice(0, 600),
              descriptionTruncated: person.description.length > 600,
            }
          : {}),
        ...(groups.includes("publicLinks") ? { links: person.links } : {}),
        updatedAt: person.updatedAt,
      }));
    },

    async readMeetingEvidence(
      noteId: string,
      cursor?: string,
      maxResultBytes = 24_000,
      compact = false,
    ) {
      const resultBytes = (value: unknown) =>
        assistantEvidenceBytes(compact ? assistantModelEvidence(value) : value);
      const overview = await withJobDatabase(env, (db) =>
        createRecordingRepository(db).overview(principal, workspaceId, noteId),
      );
      const run = overview.runs.find(
        (candidate) =>
          candidate.status === "succeeded" &&
          overview.recordings.some((audio) => audio.id === candidate.recordingId),
      );

      if (!run) {
        return {
          passages: [],
          sources: [],
          nextCursor: null,
          unavailable: "No completed transcript.",
        };
      }

      // One page is capped by both protocol source-count and result-byte limits.
      // Shrinking below this ceiling is adaptive to actual serialized evidence.
      let pageSize = ASSISTANT_TRANSCRIPT_PAGE_SIZE;

      for (;;) {
        const { page, generation } = await withJobDatabase(env, async (db) => {
          const readGeneration = async () => {
            const [row] = await db
              .select({ generation: processingRuns.transcriptGeneration })
              .from(processingRuns)
              .where(
                and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.id, run.id)),
              );

            return row?.generation;
          };

          const before = await readGeneration();
          const result = correctedTranscriptPageSchema.parse(
            await createTranscriptCorrectionRepository(db).transcript(
              principal,
              workspaceId,
              noteId,
              run.id,
              cursor,
              pageSize,
            ),
          );
          const after = await readGeneration();

          if (!before || before !== after) {
            throw new WorkspaceError(
              "conflict",
              "Meeting evidence changed while reading. Read it again.",
            );
          }

          return { page: result, generation: before };
        });
        const sources: AssistantSource[] = page.items.map((segment) => ({
          kind: "transcript",
          id: segment.id,
          label: `${segment.personName ?? segment.speakerLabel} · ${Math.floor(segment.startSeconds)}s`,
          revision: generation,
          noteId,
          recordingId: segment.recordingId,
          runId: segment.runId,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
        }));

        const result = {
          passages: page.items.map((segment) => ({
            sourceId: segment.id,
            personId: segment.assignment.kind === "person" ? segment.assignment.personId : null,
            speakerLabel: segment.speakerLabel,
            personName: segment.personName,
            text: segment.text.slice(0, 3000),
            truncated: segment.text.length > 3000,
          })),
          sources,
          nextCursor: page.nextCursor,
          coverage: assistantTranscriptCoverage(page.nextCursor, cursor),
        };

        if (
          resultBytes({
            summary: "Read saved meeting evidence.",
            data: result,
            sources,
          }) <= maxResultBytes
        ) {
          return result;
        }

        if (pageSize === 1) {
          // Keep the page cursor and evidence identity; explicitly omit oversized
          // passage text instead of replacing the whole result with an error.
          result.passages = result.passages.map((passage) => ({
            ...passage,
            text: "",
            truncated: true,
          }));

          if (
            resultBytes({
              summary: "Read saved meeting evidence.",
              data: result,
              sources,
            }) > maxResultBytes
          ) {
            return {
              passages: [],
              sources: [],
              nextCursor: page.nextCursor,
              coverage: "omitted-oversized",
              unavailable: "This passage exceeds the tool budget. No passage evidence was read.",
            };
          }

          return result;
        }

        pageSize = nextAssistantTranscriptPageSize(pageSize);
      }
    },

    async readNote(
      noteId: string,
      section: "authored" | "summary" | "transcript",
      cursor?: string,
      maxResultBytes = 24_000,
      offset = 0,
      length = 12_000,
      compact = false,
    ) {
      if (section === "authored") {
        let selectedLength = length;

        for (;;) {
          const note = await withJobDatabase(env, (db) =>
            createWorkspaceRepository(db).readNoteTranscriptPage(
              principal,
              workspaceId,
              noteId,
              offset,
              selectedLength,
            ),
          );
          // PostgreSQL substring/char_length use Unicode code points, not UTF-16 units.
          const end = Math.min(note.totalCharacters, offset + Array.from(note.text).length);
          const data = {
            section,
            note: {
              id: note.id,
              title: note.title,
              revision: note.revision,
              text: note.text,
              offset,
              nextOffset: end < note.totalCharacters ? end : null,
              totalCharacters: note.totalCharacters,
            },
            coverage: end < note.totalCharacters ? "partial" : offset ? "final-page" : "complete",
            sources: [assistantNoteSource(note)],
          };

          if (assistantEvidenceBytes(data) <= maxResultBytes) {
            return data;
          }

          if (selectedLength === 1) {
            throw new WorkspaceError("conflict", "Authored note evidence exceeds the tool budget.");
          }

          selectedLength = Math.max(1, Math.floor(selectedLength / 2));
        }
      }

      if (section === "transcript") {
        return this.readMeetingEvidence(noteId, cursor, maxResultBytes, compact);
      }

      const note = await withJobDatabase(env, (db) =>
        createWorkspaceRepository(db).getNote(principal, workspaceId, noteId),
      );

      return withJobDatabase(env, async (db) => {
        const repo = createAnalysisRepository(db);
        const overview = await repo.overview(principal, workspaceId, noteId, false);
        const result = overview.latestSummaryJobId
          ? await repo.result(principal, workspaceId, overview.latestSummaryJobId)
          : null;
        const text =
          result?.summary.analysis.quickSummary
            .map(
              (item) =>
                `${item.text}\n${item.citations.map((citation) => `${citation.evidenceId}: ${citation.quote}`).join("\n")}`,
            )
            .join("\n\n") ?? "";
        // A stale saved Summary is useful historical metadata, but it must not
        // be reintroduced as if its transcript/profile dependencies were current.
        const availableText = result?.freshness === "current" ? text : "";
        let selectedText = availableText.slice(offset, offset + length);

        const summaryResult = () => ({
          section,
          summary: result
            ? {
                id: result.summary.id,
                jobId: result.summary.jobId,
                version: result.summary.version,
                snapshotId: result.summary.snapshotId,
                source: result.summary.source,
                provenance: result.summary.provenance,
                createdAt: result.summary.createdAt,
                text: selectedText,
                offset,
                nextOffset:
                  offset + selectedText.length < availableText.length
                    ? offset + selectedText.length
                    : null,
                totalCharacters: availableText.length,
                truncated: offset + selectedText.length < availableText.length,
              }
            : null,
          freshness: result?.freshness ?? "unavailable",
          sources:
            result?.freshness === "current" && result
              ? [
                  {
                    kind: "summary" as const,
                    id: result.summary.jobId,
                    noteId: note.id,
                    label: `Summary v${result.summary.version} · ${note.title}`,
                    revision: result.summary.version,
                  },
                ]
              : [],
        });

        while (assistantEvidenceBytes(summaryResult()) > maxResultBytes) {
          if (!selectedText.length) {
            throw new WorkspaceError("conflict", "Saved Summary metadata exceeds the tool budget.");
          }

          selectedText = selectedText.slice(0, Math.floor(selectedText.length / 2));
        }

        // snapshotId stays in summary metadata; only the note is emitted as an
        // assistant source because snapshot IDs are not transcript segment IDs.
        return summaryResult();
      });
    },
  };
}
