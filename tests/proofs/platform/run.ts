import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

const cases = {
  greeting: "Hi! What should I call you, and how can you help with this meeting?",
  contact:
    "Look up the saved contact Mira Chen. What are her organization and role? What is her phone number? Use saved fields, and say when a field is not available.",
  note: "Create a new authored note titled 'Maple acceptance checklist' with exactly these two checklist items: Review pilot permissions; Confirm support owner. Save it now.",
  file: "Create and save a Markdown file titled 'Maple pilot checklist' containing exactly these two checklist items: Review pilot permissions; Confirm support owner.",
  remember: "Please remember this preference: I prefer interview preparation as a short checklist.",
  revise:
    "Update my saved interview preparation preference: I now prefer a short narrative, not a checklist. Revise the existing memory instead of making a duplicate.",
  recall: "What interview preparation format do I currently prefer? Check saved memory.",
  history:
    "Find the saved Markdown file titled 'Maple pilot checklist', read its content, and tell me the two checklist items. Do not create another file.",
  "note-corrected":
    "Create a new authored note titled 'Maple verified checklist' with exactly these two checklist items: Review pilot permissions; Confirm support owner. Save it now.",
  "revise-corrected":
    "Check my saved interview preparation preference. Change that existing preference to a short narrative instead of a checklist; do not create a duplicate memory.",
  "recall-corrected":
    "What interview preparation format do I currently prefer? Verify the current saved preference.",
} as const;

const name = z
  .enum([
    "summary",
    "summary-v6",
    "summary-v7",
    "summary-v7-low",
    "summary-v7-low-usage",
    "research",
    "research-retry",
    ...Object.keys(cases),
  ])
  .parse(process.argv[2]);
const directory = new URL("../../../.wrangler/platform-acceptance/", import.meta.url);
const manifest = z
  .object({
    contacts: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
  })
  .parse(JSON.parse(await readFile(new URL("manifest.json", directory), "utf8")));
const variables = parseEnv(await readFile(new URL("./.dev.vars", import.meta.url), "utf8"));
assert.ok(variables.PROOF_TOKEN && variables.PROOF_TOKEN.length >= 32);
const headers = { "Content-Type": "application/json", PROOF_TOKEN: variables.PROOF_TOKEN };
const evidence = new URL("evidence/", directory);
await mkdir(evidence, { recursive: true, mode: 0o700 });

const simon = manifest.contacts.find((contact) => contact.displayName === "Simon Willison");
assert.ok(simon);
const endpoint =
  name === "summary" ||
  name === "summary-v6" ||
  name === "summary-v7" ||
  name === "summary-v7-low" ||
  name === "summary-v7-low-usage"
    ? "summary"
    : name === "research" || name === "research-retry"
      ? "research"
      : "chat";
const receiptFile = new URL(`${name}-command.json`, evidence);
const commandSchema = z.object({
  endpoint: z.enum(["chat", "summary", "research"]),
  body: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
let command: z.infer<typeof commandSchema>;
try {
  command = commandSchema.parse(JSON.parse(await readFile(receiptFile, "utf8")));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  const id = randomUUID();
  const previousResearch =
    name === "research-retry"
      ? z
          .object({
            batch: z.object({
              id: z.uuid(),
              items: z
                .array(z.object({ personId: z.uuid(), generation: z.number().int().positive() }))
                .min(1),
            }),
          })
          .parse(JSON.parse(await readFile(new URL("research-result.json", evidence), "utf8")))
      : null;
  command = commandSchema.parse({
    endpoint,
    createdAt: new Date().toISOString(),
    body:
      endpoint === "chat"
        ? { turnId: id, text: cases[name as keyof typeof cases] }
        : endpoint === "summary"
          ? {
              commandId: id,
              reasoningEffort:
                name === "summary-v7-low" || name === "summary-v7-low-usage" ? "low" : "none",
            }
          : previousResearch
            ? {
                requestId: id,
                batchId: previousResearch.batch.id,
                personId: previousResearch.batch.items[0]!.personId,
                expectedGeneration: previousResearch.batch.items[0]!.generation,
              }
            : {
                requestId: id,
                people: [
                  {
                    personId: simon.id,
                    expectedProfileRevision: 1,
                    expectedContactRevision: 1,
                    requestedFacts: [
                      {
                        key: "framework",
                        question: "Which web framework does this biography say he co-created?",
                      },
                    ],
                    sourceUrls: ["https://simonwillison.net/about/"],
                  },
                ],
              },
  });
  // Persist exact identity/payload before I/O. A simultaneous runner fails closed.
  await writeFile(receiptFile, JSON.stringify(command, null, 2), { flag: "wx", mode: 0o600 });
}
assert.equal(command.endpoint, endpoint);

const base = "http://127.0.0.1:8797";
const started = performance.now();
const accepted = await fetch(`${base}/${name === "research-retry" ? "research/retry" : endpoint}`, {
  method: "POST",
  headers,
  body: JSON.stringify(command.body),
});
const admission: unknown = await accepted.json();
await writeFile(new URL(`${name}-admission.json`, evidence), JSON.stringify(admission, null, 2), {
  mode: 0o600,
});
assert.equal(
  accepted.status,
  202,
  `Admission failed (${accepted.status}); inspect saved response.`,
);
const entity = endpoint === "chat" ? "turn" : endpoint === "summary" ? "job" : "batch";
const acceptedRecord = z
  .record(z.string(), z.object({ id: z.uuid() }).passthrough())
  .parse(admission);
const id = acceptedRecord[entity]!.id;
const query = endpoint === "chat" ? "turnId" : endpoint === "summary" ? "jobId" : "batchId";
const statusSchema = z
  .object({
    status: z.string().optional(),
    items: z.array(z.object({ status: z.string() })).optional(),
  })
  .passthrough();

for (let attempt = 0; attempt < 180; attempt++) {
  const response = await fetch(`${base}/${endpoint}?${query}=${id}`, { headers });
  assert.equal(
    response.status,
    200,
    `Status failed (${response.status}); preserve command receipt.`,
  );
  const result = z.record(z.string(), z.unknown()).parse(await response.json());
  const record = statusSchema.parse(result[entity]);
  const states =
    endpoint === "research"
      ? (record.items ?? []).map((item) => item.status)
      : [record.status ?? "unknown"];
  if (states.length && states.every((status) => !["queued", "running"].includes(status))) {
    const elapsedMs = Math.round(performance.now() - started);
    await writeFile(
      new URL(`${name}-result.json`, evidence),
      JSON.stringify(
        {
          ...result,
          name,
          elapsedMs,
          observedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ name, id, states, elapsedMs }));
    process.exitCode = states.every(
      (status) => status === (endpoint === "research" ? "completed" : "succeeded"),
    )
      ? 0
      : 1;
    break;
  }
  if (attempt === 179)
    throw new Error("Still pending; preserve exact command and inspect before retry.");
  await delay(1000);
}
