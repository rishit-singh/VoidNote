import { z } from "zod";

import {
  assistantSourceSchema,
  createAssistantArtifactSchema,
  rememberAssistantMemorySchema,
} from "../../contracts/assistant";
import { contactFieldsSchema } from "../../contracts/contacts";
import { notesQuerySchema } from "../../contracts/notes";
import { peopleQuerySchema } from "../../contracts/people";
import { researchPersonRequestSchema } from "../../contracts/research";
import { researchLookupInputSchema } from "../../contracts/research/lookup";
import { requestResearchRunSchema } from "../../contracts/research/runs";

// Model-provided operation IDs are deliberately absent. The runtime derives
// them from workspace/thread/turn/tool invocation before dispatch.
export const assistantToolSchemas = {
  notes_search: notesQuerySchema,
  notes_get: z.object({ noteId: z.uuid(), cursor: z.string().max(2000).optional() }).strict(),
  contacts_search: peopleQuerySchema,
  contacts_get: z
    .object({
      personIds: z.array(z.uuid()).min(1).max(30),
      fieldGroups: z
        .array(z.enum(["identity", "professional", "publicLinks"]))
        .min(1)
        .max(3),
    })
    .strict()
    .refine((value) => new Set(value.personIds).size === value.personIds.length, {
      message: "Select each contact only once.",
    }),
  artifact_create: createAssistantArtifactSchema.omit({ operationId: true }).strict(),
  artifact_get: z
    .object({
      artifactId: z.uuid(),
      offset: z.number().int().min(0).max(100_000).default(0),
      length: z.number().int().min(1).max(2000).default(1000),
    })
    .strict(),
  history_search: z
    .object({
      query: z.string().trim().max(300),
      cursor: z.string().max(2000).optional(),
      limit: z.number().int().min(1).max(10).default(5),
    })
    .strict(),
  memory_recall: z
    .object({
      subjectId: z.uuid().nullable(),
      query: z.string().max(300),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
  memory_remember: rememberAssistantMemorySchema.omit({ operationId: true }).strict(),
  memory_invalidate: z
    .object({
      memoryId: z.uuid(),
      expectedRevision: z.number().int().positive(),
      reason: z.string().min(1).max(1000),
    })
    .strict(),
  memory_revise: z
    .object({
      memoryId: z.uuid(),
      expectedRevision: z.number().int().positive(),
      content: z.string().trim().min(1).max(8000),
      sources: z.array(assistantSourceSchema).max(30),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  research_dispatch: z
    .object({
      people: z.array(researchPersonRequestSchema).min(1).max(10),
    })
    .strict()
    .refine(
      (value) =>
        new Set(value.people.map((person) => person.personId)).size === value.people.length,
      {
        message: "Select each research contact only once.",
      },
    ),
  research_status: z.object({ batchId: z.uuid() }).strict(),
};

type LegacyAssistantToolName = keyof typeof assistantToolSchemas;

type V3AssistantToolName = LegacyAssistantToolName | "contacts_create" | "contacts_update";

export type AssistantToolName =
  | V3AssistantToolName
  | "context_read"
  | "transcript_read"
  | "research_lookup"
  | "research_get"
  | "research_status"
  | "research_cancel"
  | "work_list";
export type AssistantToolInput<Name extends AssistantToolName> = z.infer<
  (typeof assistantToolSchemasV6)[Name]
>;

export const assistantToolDescriptions: Record<LegacyAssistantToolName, string> = {
  notes_search:
    "List authorized notes by literal title prefix; not full-text search. Page only as needed.",
  notes_get:
    "Read authorized workspace note authored text, saved Summary, or transcript evidence. Transcript pages return explicit coverage and cursor; never claim full coverage until complete.",
  contacts_search:
    "Find authorized contacts by literal display-name prefix. Resolve ambiguous matches.",
  contacts_get:
    "Read up to 30 resolved contacts in one call, selecting only needed field groups: identity, professional, publicLinks. Returns current revisions.",
  artifact_create:
    "Save a requested note, text file, or annotation with source provenance and a scoped receipt.",
  artifact_get:
    "Read a bounded text section of an authorized saved artifact. Use its nextOffset for further sections; stale source dependencies are rejected.",
  history_search:
    "Search this conversation's saved messages and tool outcomes by literal text. Results are historical context; changed source dependencies are excluded.",
  memory_recall:
    "Recall scoped memory with provenance, expiry and revision; verify mutable facts against current sources.",
  memory_remember:
    "Remember an explicitly requested preference or supported claim with provenance and expiry.",
  memory_invalidate:
    "Invalidate a recalled memory by exact identity/revision when asked to forget or correct it.",
  memory_revise:
    "Revise a recalled memory with its expected revision and supporting sources, retaining its audit history and provenance.",
  research_dispatch:
    "Dispatch requested fact research for up to 10 resolved contacts with current profile revisions and known source URLs. A queued batch is not a completed finding.",
  research_status:
    "Read an authorized research batch's saved status, per-person findings and citations. Do not poll repeatedly within a turn.",
};

const toolDescriptionsV2: Record<LegacyAssistantToolName, string> = {
  ...assistantToolDescriptions,
  artifact_create:
    'Save a requested artifact. kind="note" creates a NEW authored note and REQUIRES noteId=null, even when a note is open. kind="annotation" requires the existing destination noteId and a note/transcript source on that note. Never reinterpret user intent to fix rejection.',
  memory_recall:
    'Recall active scoped memory by literal text, not semantic search. Use a short phrase. After zero matches, try a shorter phrase or query="" before asserting absence; bounded results are not a complete inventory. Verify mutable facts against current sources.',
  memory_revise:
    "Revise the recalled memoryId at expectedRevision. sources must NEVER include that target memory itself. A user-authored correction of user-stated memory may use sources=[]; source-supported memory requires independent evidence. Acknowledge only confirmed success.",
};

const toolDescriptionsV3: Record<V3AssistantToolName, string> = {
  ...toolDescriptionsV2,
  contacts_create:
    "Create a profile only when the user requests it. Use explicit display name and sourced professional/public facts; cite current evidence and acknowledge only a confirmed save.",
  contacts_update:
    "Update only explicitly supported professional/public fields on an existing profile. Include current person/contact revisions and independent current sources; never overwrite user-authored facts.",
  notes_search:
    "Search authorized workspace notes by title prefix or literal title/content match. Select the match mode and keep using the same mode and cursor for pagination.",
  notes_get:
    "Read authored text stored on a note, a saved Summary with freshness/source lineage, or transcript pages for an authorized note. Use artifact_get for saved assistant artifacts. Follow nextOffset for authored/Summary text and cursor for transcript pages; report partial coverage honestly.",
};

const toolSchemasV2 = {
  ...assistantToolSchemas,
  artifact_create: assistantToolSchemas.artifact_create.extend({
    noteId: assistantToolSchemas.artifact_create.shape.noteId.describe(
      'For kind="note", MUST be null (creates a new note). For kind="annotation", the existing destination note ID; include evidence from that note.',
    ),
  }),
  memory_recall: assistantToolSchemas.memory_recall.extend({
    query: assistantToolSchemas.memory_recall.shape.query.describe(
      'Literal text, not semantic search. After zero hits, use a shorter phrase or "" to list scoped active memories before claiming absence.',
    ),
  }),
  memory_revise: assistantToolSchemas.memory_revise.extend({
    sources: assistantToolSchemas.memory_revise.shape.sources.describe(
      "Independent evidence only; NEVER include the target memoryId itself. A correction of user-stated memory may use []; source-supported memory still requires evidence.",
    ),
  }),
};

export const assistantToolSchemasV3 = {
  ...toolSchemasV2,
  contacts_create: z
    .object({
      displayName: z.string().trim().min(1).max(200),
      fields: contactFieldsSchema.partial().default({}),
      sources: z.array(assistantSourceSchema).min(1).max(30),
    })
    .strict(),
  contacts_update: z
    .object({
      personId: z.uuid(),
      expectedPersonRevision: z.number().int().nonnegative().max(2_147_483_646),
      expectedContactRevision: z.number().int().nonnegative().max(2_147_483_646),
      fields: contactFieldsSchema
        .partial()
        .strict()
        .refine((patch) => Object.keys(patch).length > 0, "Patch at least one sourced field."),
      sources: z.array(assistantSourceSchema).min(1).max(30),
    })
    .strict()
    .superRefine((input, context) => {
      if (
        input.sources.some((source) => source.kind === "person" && source.id === input.personId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["sources"],
          message: "The profile being updated cannot be used as its own supporting evidence.",
        });
      }
    }),
  notes_search: notesQuerySchema
    .extend({
      match: z.enum(["title", "content", "title-or-content"]).default("title-or-content"),
    })
    .superRefine((value, context) => {
      if (value.match !== "title" && !value.q.trim()) {
        context.addIssue({
          code: "custom",
          path: ["q"],
          message: "Enter a literal phrase for content search.",
        });
      }
    }),
  notes_get: toolSchemasV2.notes_get.extend({
    section: z.enum(["authored", "summary", "transcript"]).default("transcript"),
    offset: z.number().int().min(0).max(500_000).optional(),
    length: z.number().int().min(1).max(12_000).default(12_000),
  }),
};

export const assistantToolSchemasV5 = {
  ...assistantToolSchemasV3,
  context_read: z.object({}).strict(),
};

export const transcriptReadInputSchema = z
  .object({
    noteId: z.uuid(),
    runId: z.uuid().optional(),
    startSeconds: z.number().nonnegative().max(7200).optional(),
    endSeconds: z.number().nonnegative().max(7200).optional(),
    personId: z.uuid().optional(),
    speakerLabel: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict()
  .refine(
    (value) =>
      value.startSeconds === undefined ||
      value.endSeconds === undefined ||
      value.startSeconds < value.endSeconds,
    "End must follow start.",
  )
  .refine(
    (value) => !(value.personId && value.speakerLabel !== undefined),
    "Select an assigned person or a provider speaker label, not both.",
  );

export const assistantToolSchemasV6 = {
  ...assistantToolSchemasV5,
  research_dispatch: z
    .object({
      question: requestResearchRunSchema.shape.question,
      subquestions: requestResearchRunSchema.shape.subquestions,
      noteId: requestResearchRunSchema.shape.noteId,
      personId: requestResearchRunSchema.shape.personId,
      sourceUrls: requestResearchRunSchema.shape.sourceUrls,
      discoverSources: z.boolean().default(true),
      timeframe: requestResearchRunSchema.shape.timeframe,
    })
    .strict()
    .refine((input) => input.discoverSources || input.sourceUrls.length > 0, {
      message: "Provide source URLs or request source discovery.",
    }),
  context_read: z
    .object({
      sections: z
        .array(z.enum(["identity", "note", "transcript"]))
        .min(1)
        .max(3)
        .default(["identity"]),
    })
    .strict(),
  transcript_read: transcriptReadInputSchema,
  research_lookup: researchLookupInputSchema,
  research_get: z
    .object({
      runId: z.uuid().optional(),
      batchId: z.uuid().optional(),
      questionIds: z.array(z.uuid()).max(8).default([]),
      section: z.enum(["report", "findings", "evidence"]).default("report"),
      offset: z.number().int().min(0).max(1000).default(0),
      limit: z.number().int().min(1).max(10).default(3),
    })
    .strict()
    .refine((value) => Boolean(value.runId) !== Boolean(value.batchId), "Select one run or batch."),
  research_cancel: z.object({ runId: z.uuid() }).strict(),
  research_status: z.object({ runId: z.uuid() }).strict(),
  work_list: z
    .object({
      noteId: z.uuid().optional(),
      status: z.enum(["active", "finished", "all"]).default("active"),
      limit: z.number().int().min(1).max(20).default(6),
    })
    .strict(),
};

/** Pinned turns retain their original instructions; descriptions never rewrite inputs. */
export function assistantToolsForVersion(version: string): {
  schemas: Record<AssistantToolName, z.ZodType>;
  descriptions: Record<AssistantToolName, string>;
} {
  if (version === "assistant-skills-v1") {
    return {
      schemas: assistantToolSchemas as unknown as Record<AssistantToolName, z.ZodType>,
      descriptions: assistantToolDescriptions as unknown as Record<AssistantToolName, string>,
    };
  }

  if (version === "assistant-skills-v2") {
    return {
      schemas: toolSchemasV2 as unknown as Record<AssistantToolName, z.ZodType>,
      descriptions: toolDescriptionsV2 as unknown as Record<AssistantToolName, string>,
    };
  }

  if (version === "assistant-skills-v3" || version === "assistant-skills-v4") {
    return {
      schemas: assistantToolSchemasV3 as unknown as Record<AssistantToolName, z.ZodType>,
      descriptions: toolDescriptionsV3 as unknown as Record<AssistantToolName, string>,
    };
  }

  if (version === "assistant-skills-v5") {
    return {
      schemas: assistantToolSchemasV5 as unknown as Record<AssistantToolName, z.ZodType>,
      descriptions: {
        ...toolDescriptionsV3,
        context_read:
          "Required first read on every turn. Read the current conversation's opened note and bounded transcript evidence through the application context manager. No arguments: scope comes from the authorized conversation. Returns source revisions, speaker identities, coverage and continuation cursors. Read further evidence with notes_get and contacts_get as needed; this is not necessarily the full transcript.",
      } as Record<AssistantToolName, string>,
    };
  }

  if (version === "assistant-skills-v6") {
    return {
      schemas: assistantToolSchemasV6,
      descriptions: {
        ...toolDescriptionsV3,
        context_read:
          "Read only requested context sections. Identity identifies the user's linked profile, not a recorded voice. Note contains bounded authored text; transcript contains a bounded opening page. Not required for greetings or general conversation. Use transcript_read for targeted evidence.",
        transcript_read:
          "Read a bounded authorized transcript range. Filter by time and either assigned person or provider speaker. Follow the returned cursor with identical filters. Coverage applies only to the selected scope; a final page does not prove earlier pages were read.",
        research_lookup:
          "Before new paid research, find relevant saved evidence and active research. A matching question is a candidate, not proof of a reusable answer. Inspect freshness and identityCurrent; reuse historical identity evidence separately from current prices. Empty matches do not establish absence; try a shorter query or a scoped empty query.",
        research_get:
          "Read a saved general research run or legacy contact-research batch. Select report, findings or evidence and optional general-run question IDs. Follow nextOffset with identical filters for more findings. Check gaps, dates and evidence before answering; this never starts new research.",
        research_dispatch:
          "Start durable research on a general question after checking saved evidence and active work with research_lookup. Person context is optional. Discovery is on by default; disable only for an explicitly source-limited task. State the precise question and timeframe. Returns durable acceptance, not an answer; use the run link and let background completion notify the user.",
        research_status:
          "Read the lifecycle, stage and gaps of one accepted research run without returning its report. Check once when useful; do not loop or imply running work has answered the question.",
        research_cancel:
          "Cancel a requested general research run. Stops future work while preserving saved evidence and accounting for already-submitted calls. A cancellation acknowledgement is not proof an external call was stopped.",
        work_list:
          "Find this conversation's research work and outcomes, optionally narrowing to a note or lifecycle status. Use when asked what happened to prior research; do not poll repeatedly within a turn.",
      },
    };
  }

  throw new Error("Unsupported assistant skill version.");
}

export function assistantToolSchemaForVersion(version: string, name: AssistantToolName) {
  return assistantToolsForVersion(version).schemas[name];
}

export const assistantToolNames = Object.keys(assistantToolSchemasV6) as AssistantToolName[];

export function assistantToolNamesForVersion(version: string): AssistantToolName[] {
  return Object.keys(assistantToolsForVersion(version).schemas) as AssistantToolName[];
}

export async function assistantOperationId(input: {
  workspaceId: string;
  threadId: string;
  turnId: string;
  toolCallId: string;
  name: string;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "assistant-operation-v1",
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.toolCallId,
      input.name,
    ]),
  );

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 16);

  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
