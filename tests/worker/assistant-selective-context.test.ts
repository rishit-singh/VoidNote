import assert from "node:assert/strict";
import { it } from "node:test";

import { assistantPolicySchema, readAssistantPolicy } from "../../src/config/assistant";
import {
  assistantIdentityForVersion,
  assistantSkillVersions,
  loadAssistantSkills,
} from "../../src/ai/assistant/skills";
import { assistantToolSchemaForVersion } from "../../src/ai/assistant/tools";

void it("pins new admissions to v6 while retaining historical v5 bundle behavior", () => {
  const environment = {
    ASSISTANT_ENABLED: "true",
    ASSISTANT_MODEL: "@cf/test/model",
    ASSISTANT_BUDGET_ID: crypto.randomUUID(),
    ASSISTANT_RATE_VERSION_ID: crypto.randomUUID(),
  };
  assert.equal(readAssistantPolicy(environment)?.skillVersion, "assistant-skills-v6");
  assert.doesNotThrow(() =>
    assistantPolicySchema.parse({
      ...environment,
      version: "assistant-v1",
      skillVersion: "assistant-skills-v5",
      model: environment.ASSISTANT_MODEL,
      budgetId: environment.ASSISTANT_BUDGET_ID,
      rateVersionId: environment.ASSISTANT_RATE_VERSION_ID,
    }),
  );
  assert.ok(loadAssistantSkills("assistant-skills-v5"));
  assert.match(assistantIdentityForVersion("assistant-skills-v5"), /context_read before/);
});

void it("gives v6 minimal selective scope and natural behavior examples", async () => {
  const identity = assistantIdentityForVersion("assistant-skills-v6");
  const skills = loadAssistantSkills("assistant-skills-v6");
  const listing = await skills.list();
  assert.ok(listing.ok);
  const conversation = listing.value.skills.find((skill) => skill.skill.name === "conversation");
  assert.ok(conversation);
  assert.doesNotMatch(identity, /context_read before/i);
  assert.match(identity, /research_lookup first/i);
  assert.match(conversation.skill.description + conversation.skill.name, /conversation/i);
  assert.ok(conversation.resources.some((resource) => resource.path === "evals/fixtures.json"));
  const fixtures = assistantSkillVersions["assistant-skills-v6"].find(
    (skill) => skill.name === "conversation",
  )!.fixtures;
  assert.deepEqual(fixtures.find((fixture) => fixture.id === "casual-greeting")?.expectedTools, []);
  assert.ok(fixtures.some((fixture) => fixture.id === "missing-research-configuration"));
  assert.ok(fixtures.some((fixture) => fixture.id === "reuse-saved-evidence"));
  const followUp = fixtures.find((fixture) => fixture.id === "follow-up-status");
  assert.match(followUp?.prompt ?? "", /accepted, queued/i);
  assert.deepEqual(followUp?.expectedTools, ["work_list", "research_get"]);
});

void it("exposes selective context and bounded transcript tool contracts in v6", () => {
  const contextRead = assistantToolSchemaForVersion("assistant-skills-v6", "context_read");
  assert.deepEqual(contextRead.parse({ sections: ["note"] }), { sections: ["note"] });
  assert.deepEqual(contextRead.parse({}), { sections: ["identity"] });

  const transcriptRead = assistantToolSchemaForVersion("assistant-skills-v6", "transcript_read");
  const noteId = crypto.randomUUID();
  assert.deepEqual(
    transcriptRead.parse({
      noteId,
      startSeconds: 4,
      endSeconds: 12,
      speakerLabel: "SPEAKER_02",
    }),
    {
      noteId,
      startSeconds: 4,
      endSeconds: 12,
      speakerLabel: "SPEAKER_02",
      limit: 30,
    },
  );
  assert.throws(() =>
    transcriptRead.parse({
      noteId: crypto.randomUUID(),
      personId: crypto.randomUUID(),
      speakerLabel: "SPEAKER_02",
    }),
  );
});
