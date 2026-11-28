import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assistantIdentityForVersion,
  assistantSkillVersions,
  loadAssistantSkills,
} from "../../src/ai/assistant/skills";
import {
  assistantOperationId,
  assistantToolNames,
  assistantToolSchemas,
  assistantToolsForVersion,
} from "../../src/ai/assistant/tools";
import { readAssistantPolicy } from "../../src/config/assistant";

void test("bundled native skill source exposes real instructions and eval resources", async () => {
  const source = loadAssistantSkills("assistant-skills-v1");
  const listing = await source.list();
  assert.ok(listing.ok);
  assert.deepEqual(listing.value.invalid, []);
  assert.equal(listing.value.skills.length, 5);
  for (const entry of listing.value.skills) {
    assert.ok(entry.skill.body.includes("## Completion checks"));
    assert.ok(entry.resources.some((resource) => resource.path === "evals/fixtures.json"));
  }
  for (const skill of assistantSkillVersions["assistant-skills-v1"]) {
    assert.ok(skill.fixtures.length > 0);
    assert.ok(skill.completionChecks.length > 1);
    for (const name of skill.allowedTools) {
      assert.ok(assistantToolNames.includes(name));
    }
  }
  assert.throws(() => loadAssistantSkills("toString"));
  const v3 = await loadAssistantSkills("assistant-skills-v3").list();
  assert.ok(v3.ok);
  assert.deepEqual(v3.value.invalid, []);
  const v4 = await loadAssistantSkills("assistant-skills-v4").list();
  assert.ok(v4.ok);
  assert.deepEqual(v4.value.invalid, []);
  assert.deepEqual(
    assistantSkillVersions["assistant-skills-v1"].map((skill) => skill.name),
    ["meeting-evidence", "contacts", "creation", "memory", "research-dispatch"],
  );
});

void test("activation fails closed without an explicit separate model/budget/rate selection", () => {
  assert.equal(readAssistantPolicy({}), null);
  assert.equal(readAssistantPolicy({ ASSISTANT_ENABLED: "true" }), null);
  assert.equal(
    readAssistantPolicy({
      ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "@cf/fixture/local-only",
      ASSISTANT_BUDGET_ID: "10000000-0000-4000-8000-000000000001",
      ASSISTANT_RATE_VERSION_ID: "unregistered-name",
    }),
    null,
  );
  assert.equal(
    readAssistantPolicy({
      ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "@cf/fixture/local-only",
      ASSISTANT_BUDGET_ID: "10000000-0000-4000-8000-000000000001",
      ASSISTANT_RATE_VERSION_ID: "10000000-0000-4000-8000-000000000006",
    })?.maxSteps,
    8,
  );
  assert.equal(
    readAssistantPolicy({
      ASSISTANT_ENABLED: "true",
      ASSISTANT_MODEL: "@cf/fixture/local-only",
      ASSISTANT_BUDGET_ID: "10000000-0000-4000-8000-000000000001",
      ASSISTANT_RATE_VERSION_ID: "10000000-0000-4000-8000-000000000006",
    })?.skillVersion,
    "assistant-skills-v6",
  );
});

void test("v4 adds conversational guidance without rewriting the v1-v3 skill bundles", () => {
  const v1Identity = assistantIdentityForVersion("assistant-skills-v1");
  const v2Identity = assistantIdentityForVersion("assistant-skills-v2");
  const v3Identity = assistantIdentityForVersion("assistant-skills-v3");
  const v4Identity = assistantIdentityForVersion("assistant-skills-v4");
  const v4 = assistantSkillVersions["assistant-skills-v4"];
  const conversation = v4.find((skill) => skill.name === "conversation")!;
  const creation = v4.find((skill) => skill.name === "creation")!;

  assert.doesNotMatch(v1Identity, /ordinary conversation directly/);
  assert.doesNotMatch(v2Identity, /ordinary conversation directly/);
  assert.doesNotMatch(v3Identity, /ordinary conversation directly/);
  assert.match(v4Identity, /follow references and apply corrections/);
  assert.match(conversation.instructions, /common typos/);
  assert.match(conversation.instructions, /research tools are for resolved contacts/);
  assert.match(creation.instructions, /Preparing content is not the same as saving/);
  assert.ok(
    conversation.fixtures.some((fixture) => fixture.id === "geohot-followup-and-correction"),
  );
  assert.ok(
    conversation.fixtures.some(
      (fixture) => fixture.id === "current-product-price-is-not-contact-research",
    ),
  );
  assert.ok(creation.fixtures.some((fixture) => fixture.id === "ambiguous-save-destination"));

  const v3Tools = assistantToolsForVersion("assistant-skills-v3");
  const v4Tools = assistantToolsForVersion("assistant-skills-v4");
  assert.deepEqual(Object.keys(v4Tools.schemas), Object.keys(v3Tools.schemas));
  assert.deepEqual(
    v4Tools.schemas.notes_get.parse({ noteId: "10000000-0000-4000-8000-000000000001" }),
    v3Tools.schemas.notes_get.parse({ noteId: "10000000-0000-4000-8000-000000000001" }),
  );
  assert.ok("contacts_create" in v4Tools.schemas);
  assert.ok("contacts_update" in v4Tools.schemas);
});

void test("v5 adds mandatory context grounding without changing pinned v4 tools or instructions", async () => {
  const source = await loadAssistantSkills("assistant-skills-v5").list();
  assert.ok(source.ok);
  assert.deepEqual(source.value.invalid, []);
  const current = assistantToolsForVersion("assistant-skills-v5");
  const previous = assistantToolsForVersion("assistant-skills-v4");
  assert.ok(!Object.hasOwn(previous.schemas, "context_read"));
  assert.deepEqual(current.schemas.context_read.parse({}), {});
  assert.equal(
    current.schemas.context_read.safeParse({ noteId: crypto.randomUUID() }).success,
    false,
  );
  assert.match(
    assistantIdentityForVersion("assistant-skills-v5"),
    /application runs context_read before your first model request/,
  );
  assert.match(
    assistantIdentityForVersion("assistant-skills-v5"),
    /Preserve relevant user instructions/,
  );
  assert.doesNotMatch(assistantIdentityForVersion("assistant-skills-v4"), /context_read/);
});

void test("v2 native skill registry includes corrective guidance and preserves historical v1", async () => {
  const source = loadAssistantSkills("assistant-skills-v2");
  const listing = await source.list();
  assert.ok(listing.ok);
  assert.deepEqual(listing.value.invalid, []);
  const creation = listing.value.skills.find((entry) => entry.skill.name === "creation")!;
  const memory = listing.value.skills.find((entry) => entry.skill.name === "memory")!;
  assert.match(creation.skill.body, /noteId MUST be null/);
  assert.match(creation.skill.body, /existing destination noteId/);
  assert.match(memory.skill.body, /sources=\[\] is allowed/);
  assert.match(memory.skill.body, /NEVER contain the target memory/);
  assert.match(memory.skill.body, /After zero matches/);
  assert.match(assistantIdentityForVersion("assistant-skills-v2"), /Keep internal UUIDs/);
  assert.doesNotMatch(assistantIdentityForVersion("assistant-skills-v1"), /Keep internal UUIDs/);
  assert.equal(assistantSkillVersions["assistant-skills-v1"][2].version, "1.0.0");
});

void test("batch contact, paged note and research inputs match the scoped application operations", () => {
  const personId = "10000000-0000-4000-8000-000000000001";
  assert.equal(
    assistantToolSchemas.contacts_get.safeParse({
      personIds: [personId],
      fieldGroups: ["identity", "professional"],
    }).success,
    true,
  );
  assert.equal(
    assistantToolSchemas.contacts_get.safeParse({
      personId,
    }).success,
    false,
  );
  assert.equal(
    assistantToolSchemas.contacts_get.safeParse({
      personIds: [personId, personId],
      fieldGroups: ["identity"],
    }).success,
    false,
  );
  assert.equal(
    assistantToolSchemas.notes_get.safeParse({
      noteId: personId,
      cursor: "returned-cursor",
    }).success,
    true,
  );
  const person = {
    personId,
    expectedProfileRevision: 1,
    requestedFacts: [{ key: "employer", question: "Who is the current employer?" }],
    sourceUrls: ["https://example.com/profile"],
  };
  assert.equal(
    assistantToolSchemas.research_dispatch.safeParse({ people: [person] }).success,
    true,
  );
  assert.equal(
    assistantToolSchemas.research_dispatch.safeParse({ people: [person, person] }).success,
    false,
  );
  assert.equal(
    assistantToolSchemas.research_dispatch.safeParse({ people: [person], requestId: personId })
      .success,
    false,
  );
  assert.equal(assistantToolSchemas.research_status.safeParse({ batchId: personId }).success, true);
});

void test("mutation IDs are stable per scoped invocation and cannot be supplied by the model", async () => {
  const input = {
    workspaceId: "workspace-a",
    threadId: "thread-a",
    turnId: "turn-a",
    toolCallId: "tool-a",
    name: "artifact_create",
  };
  const original = await assistantOperationId(input);
  assert.equal(await assistantOperationId(input), original);
  assert.notEqual(await assistantOperationId({ ...input, workspaceId: "workspace-b" }), original);
  assert.notEqual(await assistantOperationId({ ...input, turnId: "turn-b" }), original);
  assert.notEqual(await assistantOperationId({ ...input, toolCallId: "tool-b" }), original);
  assert.equal(
    assistantToolSchemas.artifact_create.safeParse({
      operationId: original,
      kind: "file",
      noteId: null,
      name: "Draft",
      mediaType: "text/plain",
      content: "hello",
      sources: [],
    }).success,
    false,
  );
  for (const name of ["execute", "sql", "set_context"]) {
    assert.ok(!(assistantToolNames as string[]).includes(name));
  }
});
