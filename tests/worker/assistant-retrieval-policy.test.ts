import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assistantEvidenceBytes,
  assistantNoteSource,
  assistantTranscriptCoverage,
  ASSISTANT_TRANSCRIPT_PAGE_SIZE,
  nextAssistantTranscriptPageSize,
} from "../../src/ai/assistant-context.ts";
import {
  assistantToolSchemaForVersion,
  assistantToolNamesForVersion,
  assistantToolsForVersion,
} from "../../src/ai/assistant/tools.ts";
import { assistantSourceSchema } from "../../src/contracts/assistant/index.ts";
import { assistantPolicySchema, readAssistantPolicy } from "../../src/config/assistant.ts";

const noteId = "10000000-0000-4000-8000-000000000005";
const personId = "10000000-0000-4000-8000-000000000006";

void test("new admissions reserve synthesis capacity without changing the historical schema default", () => {
  assert.equal(
    assistantPolicySchema.parse({
      version: "assistant-v1",
      skillVersion: "assistant-skills-v1",
      model: "fixture",
      budgetId: noteId,
      rateVersionId: noteId,
    }).maxSteps,
    4,
  );

  assert.equal(
    readAssistantPolicy({
      ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "fixture",
      ASSISTANT_BUDGET_ID: noteId,
      ASSISTANT_RATE_VERSION_ID: noteId,
    })?.maxSteps,
    8,
  );
});

void test("historical tool schemas stay byte-contract compatible; v3 owns the sectioned read contract", () => {
  for (const version of ["assistant-skills-v1", "assistant-skills-v2"]) {
    assert.deepEqual(assistantToolsForVersion(version).schemas.notes_get.parse({ noteId }), {
      noteId,
    });
    assert.throws(() =>
      assistantToolSchemaForVersion(version, "notes_get").parse({
        noteId,
        section: "authored",
      }),
    );
  }

  assert.deepEqual(
    assistantToolSchemaForVersion("assistant-skills-v3", "notes_get").parse({ noteId }),
    { noteId, section: "transcript", length: 12_000 },
  );
});

void test("v6 research dispatch advertises the default pinned total-question limit", () => {
  const schema = assistantToolSchemaForVersion("assistant-skills-v6", "research_dispatch");
  const base = {
    question: "What changed in the project?",
    noteId: null,
    personId: null,
    sourceUrls: ["https://example.com/research"],
    discoverSources: false,
  };

  assert.equal(
    schema.safeParse({
      ...base,
      subquestions: ["What is the current state?", "What is planned?", "What are the risks?"],
    }).success,
    true,
  );
  assert.equal(
    schema.safeParse({
      ...base,
      subquestions: [
        "What is the current state?",
        "What is planned?",
        "What are the risks?",
        "What is the timeline?",
      ],
    }).success,
    false,
  );
});

void test("profile mutation tools are exposed only to v3 and require sourced revision fences", () => {
  assert.ok(!assistantToolNamesForVersion("assistant-skills-v1").includes("contacts_create"));
  assert.ok(!assistantToolNamesForVersion("assistant-skills-v2").includes("contacts_update"));
  assert.ok(assistantToolNamesForVersion("assistant-skills-v3").includes("contacts_create"));

  const schemas = assistantToolsForVersion("assistant-skills-v3").schemas;
  assert.equal(
    schemas.contacts_create.safeParse({
      displayName: "Ada",
      sources: [],
    }).success,
    false,
  );
  assert.equal(
    schemas.contacts_update.safeParse({
      personId,
      expectedPersonRevision: 1,
      expectedContactRevision: 1,
      fields: { role: "Researcher" },
      sources: [{ kind: "person", id: personId, label: "Ada", revision: 1 }],
    }).success,
    false,
  );
  assert.equal(
    assistantToolSchemaForVersion("assistant-skills-v3", "contacts_update").safeParse({
      personId,
      expectedPersonRevision: 1,
      expectedContactRevision: 1,
      fields: { role: "Researcher" },
      sources: [{ kind: "note", id: noteId, label: "Meeting", revision: 1 }],
    }).success,
    true,
  );
});

void test("evidence pages begin large, shrink to the serialized byte budget, and disclose coverage", () => {
  assert.equal(ASSISTANT_TRANSCRIPT_PAGE_SIZE, 100);
  let size = ASSISTANT_TRANSCRIPT_PAGE_SIZE;
  const cap = 24_000;
  const serializedPageBytes = (pageSize: number) =>
    assistantEvidenceBytes({ passages: Array.from({ length: pageSize }, () => "x".repeat(3000)) });

  while (serializedPageBytes(size) > cap && size > 1) {
    size = nextAssistantTranscriptPageSize(size);
  }

  assert.ok(size > 1, "the ordinary passage size should allow useful multi-item pages");
  assert.ok(serializedPageBytes(size) <= cap);
  assert.equal(assistantTranscriptCoverage("next-page-token", undefined), "partial-page");
  assert.equal(assistantTranscriptCoverage(null, "prior-page-token"), "final-page");
  assert.equal(assistantTranscriptCoverage(null, undefined), "complete");
});

void test("authored and saved-summary citations use valid note identity, never snapshot-as-segment identity", () => {
  const noteSource = assistantSourceSchema.parse(
    assistantNoteSource({ id: noteId, title: "Podcast", revision: 3 }),
  );

  assert.equal(noteSource.kind, "note");
  assert.equal(noteSource.id, noteId);
  assert.equal(noteSource.revision, 3);
});
