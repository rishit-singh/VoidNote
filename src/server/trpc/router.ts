import "server-only";

import { z } from "zod";
import {
  analysisJobSchema,
  requestSummarySchema,
  savedSummarySchema,
  summaryAcceptedSchema,
  summaryEvidenceSchema,
} from "@/contracts/analysis";
import { createAnalysisRepository } from "@/db/analysis";
import { analysisPolicy, notifySummaryJob, summaryEvidence } from "@/server/analysis";
import { workspaceOverviewSchema } from "@/contracts/workspace-overview";
import {
  deleteSchema,
  historySchema,
  idSchema,
  listQuerySchema,
  noteListSchema,
  noteSchema,
  notesQuerySchema,
  peopleQuerySchema,
  personListSchema,
  personSchema,
  saveNoteSchema,
  savePersonSchema,
  sessionSchema,
  WorkspaceError,
} from "@/contracts/workspace";
import {
  processingRequestSchema,
  processingRunSchema,
  recordingInputSchema,
  recordingOverviewSchema,
  recordingSchema,
} from "@/contracts/recording-processing";
import {
  correctedTranscriptPageSchema,
  correctionCommandSchema,
  correctionHistoryPageSchema,
  correctionResultSchema,
  correctionTargetsSchema,
  personAppearancesSchema,
} from "@/contracts/transcript-corrections";
import { withDatabase, type Database } from "@/db/client";
import { createWorkspaceRepository } from "@/db/repository";
import { createRecordingRepository } from "@/db/recording-repository";
import { createTranscriptCorrectionRepository } from "@/db/transcript-correction-repository";
import { recordingEnvironment } from "@/server/recording-api";
import { authenticatedProcedure as procedure, router } from "./init";

// Repositories and their database handles never escape withDatabase's lifetime.
function repositoryScope<R>(factory: (db: Database) => R) {
  return <T>(work: (repository: R) => Promise<T>) => withDatabase((db) => work(factory(db)));
}
const workspace = repositoryScope(createWorkspaceRepository);
const recording = repositoryScope(createRecordingRepository);
const correction = repositoryScope(createTranscriptCorrectionRepository);
const analysis = repositoryScope(createAnalysisRepository);
const scope = z.object({ workspaceId: idSchema });
const noteScope = scope.extend({ noteId: idSchema });
const runScope = noteScope.extend({ runId: idSchema });
const cursor = z.string().max(2000).optional();
const getInput = scope.extend({ id: idSchema, includeDeleted: z.boolean().default(false) });
const deleteInput = scope.extend({ command: deleteSchema });
const limit = z.number().int().min(1).max(50).default(30);
const targetsInput = runScope
  .extend({
    speakerLabel: z.string().max(200).optional(),
    startSeconds: z.number().min(0).max(7200).optional(),
    endSeconds: z.number().min(0).max(7200).optional(),
    includeManual: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.startSeconds === undefined && value.endSeconds === undefined) ||
      (value.speakerLabel === undefined &&
        value.startSeconds !== undefined &&
        value.endSeconds !== undefined &&
        value.endSeconds > value.startSeconds),
  );

export const appRouter = router({
  summaries: router({
    evidence: procedure
      .input(scope.extend({ jobId: idSchema }))
      .output(summaryEvidenceSchema)
      .query(async ({ ctx, input }) => {
        const snapshot = await analysis((repo) =>
          repo.evidence(ctx.principal, input.workspaceId, input.jobId),
        );

        return summaryEvidence(input.workspaceId, input.jobId, snapshot);
      }),
    request: procedure
      .input(scope.extend({ command: requestSummarySchema }))
      .output(summaryAcceptedSchema)
      .mutation(async ({ ctx, input }) => {
        const policy = analysisPolicy();
        const job = await analysis((repo) =>
          repo.request(ctx.principal, input.workspaceId, input.command, policy),
        );
        if (policy !== null && job.status === "queued") {
          notifySummaryJob(input.workspaceId, job.id);
        }
        return { job };
      }),
    job: procedure
      .input(scope.extend({ jobId: idSchema }))
      .output(analysisJobSchema)
      .query(({ ctx, input }) =>
        analysis((repo) => repo.get(ctx.principal, input.workspaceId, input.jobId)),
      ),
    result: procedure
      .input(scope.extend({ jobId: idSchema }))
      .output(z.object({ summary: savedSummarySchema, freshness: z.enum(["current", "stale"]) }))
      .query(({ ctx, input }) =>
        analysis((repo) => repo.result(ctx.principal, input.workspaceId, input.jobId)),
      ),
    cancel: procedure
      .input(scope.extend({ jobId: idSchema }))
      .output(analysisJobSchema)
      .mutation(async ({ ctx, input }) => {
        const job = await analysis((repo) =>
          repo.cancel(ctx.principal, input.workspaceId, input.jobId),
        );
        if (job.status === "cancelled") {
          notifySummaryJob(input.workspaceId, job.id, true);
        }
        return job;
      }),
  }),
  workspace: router({
    overview: procedure
      .input(scope)
      .output(workspaceOverviewSchema)
      .query(({ ctx, input }) =>
        workspace((repo) => repo.overview(ctx.principal, input.workspaceId)),
      ),
    session: procedure.output(sessionSchema).query(({ ctx }) =>
      workspace(async (repo) => ({
        user: ctx.principal,
        workspace: await repo.ensureWorkspace(ctx.principal),
      })),
    ),
    history: procedure
      .input(
        listQuerySchema.extend({
          ...scope.shape,
          limit,
          entityType: z.enum(["note", "person"]),
          entityId: idSchema,
        }),
      )
      .output(historySchema)
      .query(({ ctx, input }) =>
        workspace((repo) =>
          repo.history(ctx.principal, input.workspaceId, input.entityType, input.entityId, input),
        ),
      ),
  }),
  notes: router({
    list: procedure
      .input(notesQuerySchema.extend({ ...scope.shape, limit }))
      .output(noteListSchema)
      .query(({ ctx, input }) =>
        workspace((repo) => repo.listNotes(ctx.principal, input.workspaceId, input)),
      ),
    get: procedure
      .input(getInput)
      .output(noteSchema)
      .query(({ ctx, input }) =>
        workspace((repo) =>
          repo.getNote(ctx.principal, input.workspaceId, input.id, input.includeDeleted),
        ),
      ),
    save: procedure
      .input(scope.extend({ command: saveNoteSchema }))
      .output(noteSchema)
      .mutation(({ ctx, input }) =>
        workspace((repo) => repo.saveNote(ctx.principal, input.workspaceId, input.command)),
      ),
    delete: procedure
      .input(deleteInput)
      .output(noteSchema)
      .mutation(({ ctx, input }) =>
        workspace((repo) => repo.deleteNote(ctx.principal, input.workspaceId, input.command)),
      ),
  }),
  people: router({
    list: procedure
      .input(peopleQuerySchema.extend({ ...scope.shape, limit }))
      .output(personListSchema)
      .query(({ ctx, input }) =>
        workspace((repo) => repo.listPeople(ctx.principal, input.workspaceId, input)),
      ),
    get: procedure
      .input(getInput)
      .output(personSchema)
      .query(({ ctx, input }) =>
        workspace((repo) =>
          repo.getPerson(ctx.principal, input.workspaceId, input.id, input.includeDeleted),
        ),
      ),
    save: procedure
      .input(scope.extend({ command: savePersonSchema }))
      .output(personSchema)
      .mutation(({ ctx, input }) =>
        workspace((repo) => repo.savePerson(ctx.principal, input.workspaceId, input.command)),
      ),
    delete: procedure
      .input(deleteInput)
      .output(personSchema)
      .mutation(({ ctx, input }) =>
        workspace((repo) => repo.deletePerson(ctx.principal, input.workspaceId, input.command)),
      ),
    appearances: procedure
      .input(scope.extend({ id: idSchema, cursor }))
      .output(personAppearancesSchema)
      .query(({ ctx, input }) =>
        correction((repo) =>
          repo.appearances(ctx.principal, input.workspaceId, input.id, input.cursor),
        ),
      ),
  }),
  recordings: router({
    overview: procedure
      .input(noteScope)
      .output(recordingOverviewSchema)
      .query(({ ctx, input }) =>
        recording((repo) => repo.overview(ctx.principal, input.workspaceId, input.noteId)),
      ),
    initialize: procedure
      .input(noteScope.extend({ command: recordingInputSchema }))
      .output(recordingSchema)
      .mutation(({ ctx, input }) =>
        recording((repo) =>
          repo.initialize(ctx.principal, input.workspaceId, input.noteId, input.command),
        ),
      ),
  }),
  processing: router({
    start: procedure
      .input(noteScope.extend({ command: processingRequestSchema }))
      .output(processingRunSchema)
      .mutation(({ ctx, input }) =>
        recording(async (repo) => {
          const env = recordingEnvironment();
          if (!env.PYANNOTE_API_KEY || !env.RECORDING_CAPABILITY_SECRET)
            throw new Error("Configure the finalized transcription provider.");
          const run = await repo.requestProcessing(
            ctx.principal,
            input.workspaceId,
            input.noteId,
            input.command.recordingId,
            input.command.id,
          );
          // The committed outbox reconciles the exact run if dispatch fails.
          const result = await env.PROCESS_RECORDING.createBatch({
            instances: [{ id: run.id, params: { workspaceId: input.workspaceId, runId: run.id } }],
          });
          if (result.created.length || result.errors.some((error) => error.code === 10405))
            await repo.dispatched(input.workspaceId, run.id);
          return run;
        }),
      ),
    retry: procedure.input(runScope).mutation(({ ctx, input }) =>
      recording(async (repo) => {
        const { runs } = await repo.overview(ctx.principal, input.workspaceId, input.noteId);
        const run = runs.find((item) => item.id === input.runId);
        if (!run) throw new WorkspaceError("not_found", "Run not found.");
        const binding = recordingEnvironment().PROCESS_RECORDING;
        const result = await binding.createBatch({
          instances: [
            { id: run.id, params: { workspaceId: input.workspaceId, runId: input.runId } },
          ],
        });
        if (result.errors.some((error) => error.code === 10405)) {
          const instance = await binding.get(input.runId);
          const state = await instance.status();
          if (
            state.status === "errored" ||
            state.status === "terminated" ||
            (state.status === "complete" && run.status !== "succeeded")
          )
            await instance.restart();
        } else if (!result.created.length) {
          throw new Error("Processing recovery could not be started. Please retry.");
        }
        return { ok: true };
      }),
    ),
  }),
  transcripts: router({
    page: procedure
      .input(runScope.extend({ cursor }))
      .output(correctedTranscriptPageSchema)
      .query(({ ctx, input }) =>
        correction((repo) =>
          repo.transcript(
            ctx.principal,
            input.workspaceId,
            input.noteId,
            input.runId,
            input.cursor,
          ),
        ),
      ),
    command: procedure
      .input(runScope.extend({ command: correctionCommandSchema }))
      .output(correctionResultSchema)
      .mutation(({ ctx, input }) =>
        correction((repo) =>
          repo.command(ctx.principal, input.workspaceId, input.noteId, input.runId, input.command),
        ),
      ),
    history: procedure
      .input(runScope.extend({ cursor }))
      .output(correctionHistoryPageSchema)
      .query(({ ctx, input }) =>
        correction((repo) =>
          repo.history(ctx.principal, input.workspaceId, input.noteId, input.runId, input.cursor),
        ),
      ),
    targets: procedure
      .input(targetsInput)
      .output(correctionTargetsSchema)
      .query(({ ctx, input }) => {
        const { workspaceId, noteId, runId, ...query } = input;
        return correction((repo) => repo.targets(ctx.principal, workspaceId, noteId, runId, query));
      }),
  }),
});

export type AppRouter = typeof appRouter;
