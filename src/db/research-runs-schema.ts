import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  integer,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { ResearchRunPolicy } from "../config/research-runs";
import type { InferenceUsage } from "../ai/inference";
import type {
  ResearchRunDetail,
  ResearchRunStatus,
  ResearchRunStage,
} from "../contracts/research/runs";
import { assistantTurns } from "./assistant-schema";
import { notes, people, workspaceMemberships, workspaces } from "./schema";

const time = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

export const researchRuns = pgTable(
  "research_runs",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    id: uuid("id").notNull(),
    actorId: uuid("actor_id").notNull(),
    originTurnId: uuid("origin_turn_id"),
    noteId: uuid("note_id"),
    personId: uuid("person_id"),
    personRevision: integer("person_revision"),
    contactRevision: integer("contact_revision"),
    question: text("question").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    policy: jsonb("policy").$type<ResearchRunPolicy>().notNull(),
    status: text("status").$type<ResearchRunStatus>().notNull().default("queued"),
    stage: text("stage").$type<ResearchRunStage>().notNull().default("queued"),
    report: jsonb("report").$type<ResearchRunDetail["report"]>(),
    error: text("error"),
    discoveryState: text("discovery_state").notNull().default("pending"),
    discoveryCreditsUsed: integer("discovery_credits_used"),
    dispatchCheckedAt: time("dispatch_checked_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }),
    foreignKey({
      columns: [t.workspaceId, t.originTurnId],
      foreignColumns: [assistantTurns.workspaceId, assistantTurns.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }),
    check(
      "research_runs_person_revision",
      sql`(${t.personId} is null and ${t.personRevision} is null and ${t.contactRevision} is null) or (${t.personId} is not null and ${t.personRevision} > 0 and ${t.contactRevision} >= 0)`,
    ),
    foreignKey({
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [notes.workspaceId, notes.id],
    }),
    check(
      "research_runs_status",
      sql`${t.status} in ('queued','running','completed','failed','cancelled')`,
    ),
    check(
      "research_runs_stage",
      sql`${t.stage} in ('queued','planning','retrieving','analyzing','synthesizing','publishing','finished')`,
    ),
    check("research_runs_payload_bound", sql`octet_length(${t.payload}::text) <= 50000`),
    check("research_runs_policy_bound", sql`octet_length(${t.policy}::text) <= 20000`),
    check(
      "research_runs_report_bound",
      sql`${t.report} is null or octet_length(${t.report}::text) <= 200000`,
    ),
    check(
      "research_runs_publication_consistency",
      sql`(${t.status} = 'completed') = (${t.report} is not null)`,
    ),
    check(
      "research_runs_discovery_state",
      sql`${t.discoveryState} in ('pending','submitted','completed')`,
    ),
    index("research_runs_workspace_created").on(t.workspaceId, t.createdAt.desc(), t.id),
    index("research_runs_dispatch")
      .on(sql`coalesce(${t.dispatchCheckedAt}, ${t.updatedAt})`, t.workspaceId, t.id)
      .where(sql`${t.status} in ('queued','running')`),
    index("research_runs_origin_note").on(t.workspaceId, t.noteId, t.createdAt.desc()),
  ],
).enableRLS();

export const researchRunCommands = pgTable(
  "research_run_commands",
  {
    workspaceId: uuid("workspace_id").notNull(),
    commandId: uuid("command_id").notNull(),
    runId: uuid("run_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.commandId] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [researchRuns.workspaceId, researchRuns.id],
    }),
  ],
).enableRLS();

export const researchRunQuestions = pgTable(
  "research_run_questions",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    id: uuid("id").notNull(),
    ordinal: integer("ordinal").notNull(),
    question: text("question").notNull(),
    outcome: text("outcome").notNull().default("pending"),
    operationId: uuid("operation_id").notNull(),
    inferenceState: text("inference_state").notNull().default("pending"),
    inferenceResult: jsonb("inference_result").$type<unknown>(),
    inferenceUsage: jsonb("inference_usage").$type<InferenceUsage | null>(),
    error: text("error"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.runId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [researchRuns.workspaceId, researchRuns.id],
    }),
    check(
      "research_run_questions_outcome",
      sql`${t.outcome} in ('pending','supported','conflicting','insufficient-evidence','failed')`,
    ),
    check(
      "research_run_questions_inference_state",
      sql`${t.inferenceState} in ('pending','submitted','settled')`,
    ),
    check(
      "research_run_questions_result_bound",
      sql`${t.inferenceResult} is null or octet_length(${t.inferenceResult}::text) <= 30000`,
    ),
    index("research_run_questions_order").on(t.workspaceId, t.runId, t.ordinal),
  ],
).enableRLS();

export const researchRunDiscoveries = pgTable(
  "research_run_discoveries",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    operationId: uuid("operation_id").notNull(),
    query: text("query"),
    state: text("state").notNull().default("pending"),
    creditsUsed: integer("credits_used"),
    candidates: jsonb("candidates").$type<unknown[]>().notNull().default([]),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.runId, t.ordinal] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [researchRuns.workspaceId, researchRuns.id],
    }),
    check("research_run_discoveries_ordinal", sql`${t.ordinal} in (0,1)`),
    check("research_run_discoveries_state", sql`${t.state} in ('pending','submitted','completed')`),
    check(
      "research_run_discoveries_candidates_bound",
      sql`octet_length(${t.candidates}::text) <= 40000`,
    ),
    index("research_run_discoveries_dispatch").on(t.workspaceId, t.runId, t.state),
  ],
).enableRLS();

export const researchRunSources = pgTable(
  "research_run_sources",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    id: uuid("id").notNull(),
    requestedUrl: text("requested_url").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    publishedAt: time("published_at"),
    originSourceId: text("origin_source_id"),
    digest: text("digest").notNull(),
    retrievedAt: time("retrieved_at").notNull(),
    content: text("content").notNull(),
    disposition: text("disposition").notNull().default("retrieved"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.runId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [researchRuns.workspaceId, researchRuns.id],
    }),
    check("research_run_sources_content_bound", sql`octet_length(${t.content}) <= 128000`),
    index("research_run_sources_url").on(t.workspaceId, t.url, t.retrievedAt.desc()),
  ],
).enableRLS();

export const researchRunFindings = pgTable(
  "research_run_findings",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    id: uuid("id").notNull(),
    questionId: uuid("question_id").notNull(),
    outcome: text("outcome").notNull(),
    statement: text("statement"),
    classification: text("classification"),
    explanation: text("explanation").notNull(),
    citations: jsonb("citations")
      .$type<ResearchRunDetail["findings"][number]["citations"]>()
      .notNull()
      .default([]),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.runId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [researchRuns.workspaceId, researchRuns.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.runId, t.questionId],
      foreignColumns: [
        researchRunQuestions.workspaceId,
        researchRunQuestions.runId,
        researchRunQuestions.id,
      ],
    }),
    check(
      "research_run_findings_outcome",
      sql`${t.outcome} in ('supported','conflicting','insufficient-evidence','failed')`,
    ),
    check(
      "research_run_findings_classification",
      sql`${t.classification} is null or ${t.classification} in ('direct-evidence','deduction')`,
    ),
  ],
).enableRLS();

export const researchRunFindingEvidence = pgTable(
  "research_run_finding_evidence",
  {
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    findingId: uuid("finding_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    relation: text("relation").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    excerpt: text("excerpt").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.runId, t.findingId, t.sourceId, t.startOffset] }),
    foreignKey({
      columns: [t.workspaceId, t.runId, t.findingId],
      foreignColumns: [
        researchRunFindings.workspaceId,
        researchRunFindings.runId,
        researchRunFindings.id,
      ],
    }),
    foreignKey({
      columns: [t.workspaceId, t.runId, t.sourceId],
      foreignColumns: [
        researchRunSources.workspaceId,
        researchRunSources.runId,
        researchRunSources.id,
      ],
    }),
    check(
      "research_run_finding_evidence_relation",
      sql`${t.relation} in ('supports','contradicts','premise')`,
    ),
    check(
      "research_run_finding_evidence_offsets",
      sql`${t.startOffset} >= 0 and ${t.endOffset} > ${t.startOffset}`,
    ),
    index("research_run_finding_evidence_finding").on(t.workspaceId, t.runId, t.findingId),
  ],
).enableRLS();
