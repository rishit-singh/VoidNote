import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";

import { summaryPolicy, summaryReservationMicroUsd } from "../../../src/ai/runtime";
import { createAssistantRepository } from "../../../src/db/assistant";
import { assistantThreads } from "../../../src/db/assistant-schema";
import { createContactRepository } from "../../../src/db/contacts";
import { inferenceBudgets, inferenceRates } from "../../../src/db/inference-schema";
import { createRecordingRepository } from "../../../src/db/recording-repository";
import { createWorkspaceRepository } from "../../../src/db/repository";
import * as schema from "../../../src/db/schema";
import { createTranscriptCorrectionRepository } from "../../../src/db/transcript-correction-repository";

const databaseUrl =
  "postgresql://postgres:postgres@127.0.0.1:54322/voidnote_platform_acceptance_20261125";
const model = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const pricingSource =
  "https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/";
const manifestFile = new URL(
  "../../../.wrangler/platform-acceptance/manifest.json",
  import.meta.url,
);
const id = z.uuid();
const manifestSchema = z.object({
  version: z.literal(1),
  database: z.literal("voidnote_platform_acceptance_20261125"),
  model: z.literal(model),
  createdAt: z.iso.datetime(),
  pricingSource: z.literal(pricingSource),
  principal: z.object({ id, email: z.literal("platform-acceptance@example.invalid") }),
  workspaceId: id,
  noteId: id,
  noteCommandId: id,
  recordingId: id,
  runId: id,
  threadId: id,
  rateVersionId: id,
  budgets: z.object({ chat: id, research: id, legacySummary: id }),
  contacts: z
    .array(
      z.object({
        id,
        commandId: id,
        contactOperationId: id,
        attributionCommandId: id,
        displayName: z.string(),
        description: z.string(),
        organization: z.string(),
        role: z.string(),
        track: z.string(),
        links: z.array(z.object({ label: z.string(), url: z.url() })),
      }),
    )
    .length(2),
});

// Persist identities before any database side effect. Exclusive creation prevents
// concurrent starts from minting additional allowances. A damaged file fails closed.
async function manifest() {
  await mkdir(new URL(".", manifestFile), { recursive: true });
  try {
    return manifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const value = manifestSchema.parse({
    version: 1,
    database: "voidnote_platform_acceptance_20261125",
    model,
    createdAt: new Date().toISOString(),
    pricingSource,
    principal: { id: randomUUID(), email: "platform-acceptance@example.invalid" },
    workspaceId: randomUUID(),
    noteId: randomUUID(),
    noteCommandId: randomUUID(),
    recordingId: randomUUID(),
    runId: randomUUID(),
    threadId: randomUUID(),
    rateVersionId: randomUUID(),
    budgets: { chat: randomUUID(), research: randomUUID(), legacySummary: randomUUID() },
    contacts: [
      {
        displayName: "Mira Chen (synthetic)",
        description: "Synthetic acceptance fixture; not a real person.",
        organization: "Maple Test Cooperative (synthetic)",
        role: "Pilot lead",
        track: "SPEAKER_00",
        links: [{ label: "Synthetic placeholder (not evidence)", url: "https://example.org/" }],
      },
      {
        displayName: "Simon Willison",
        description:
          "Public biography research guest. Not a participant in this synthetic meeting. Verify facts against the supplied source.",
        organization: "",
        role: "",
        track: "",
        links: [{ label: "Public biography", url: "https://simonwillison.net/about/" }],
      },
    ].map((contact) => ({
      ...contact,
      id: randomUUID(),
      commandId: randomUUID(),
      contactOperationId: randomUUID(),
      attributionCommandId: randomUUID(),
    })),
  });
  try {
    await writeFile(manifestFile, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return value;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return manifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  }
}

const proof = await manifest();
// Deliberately no DATABASE_URL/TEST_DATABASE_URL fallback or target override.
const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });

try {
  const [target] = await client<{ name: string }[]>`select current_database() as name`;
  assert.equal(target?.name, proof.database);
  // Serialize migration and seed, including two invocations sharing the manifest.
  await client`select pg_advisory_lock(hashtext('voidnote-platform-acceptance-20261125'))`;
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)),
  });
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: assistantThreads.id })
      .from(assistantThreads)
      .where(
        and(
          eq(assistantThreads.workspaceId, proof.workspaceId),
          eq(assistantThreads.id, proof.threadId),
          eq(assistantThreads.actorId, proof.principal.id),
        ),
      );
    // The thread is committed atomically with the complete seed. Reruns do not
    // rewrite rates, budgets, balances, contacts, transcript, or command receipts.
    if (existing) {
      const [rate] = await tx
        .select()
        .from(inferenceRates)
        .where(eq(inferenceRates.id, proof.rateVersionId));
      assert.ok(rate, "Missing fixed rate; refusing to recreate allowances.");
      assert.equal(rate.provider, "workers-ai");
      assert.equal(rate.model, model);
      assert.equal(rate.currency, "USD");
      assert.equal(rate.inputMicroUsdPerMillionTokens, 300_000);
      assert.equal(rate.outputMicroUsdPerMillionTokens, 1_200_000);
      for (const [budgetId, limit] of [
        [proof.budgets.chat, 1_000_000],
        [proof.budgets.research, 500_000],
      ] as const) {
        const [budget] = await tx
          .select()
          .from(inferenceBudgets)
          .where(
            and(
              eq(inferenceBudgets.workspaceId, proof.workspaceId),
              eq(inferenceBudgets.id, budgetId),
            ),
          );
        assert.ok(budget, "Missing fixed budget; refusing to recreate an allowance.");
        assert.equal(budget.rateVersionId, proof.rateVersionId);
        assert.equal(budget.limitMicroUsd, limit);
        assert.ok(budget.approvedAt);
      }
      const [summary] = await tx
        .select()
        .from(schema.summaryInferenceBudgets)
        .where(eq(schema.summaryInferenceBudgets.id, proof.budgets.legacySummary));
      assert.ok(summary, "Missing fixed summary budget; refusing to recreate an allowance.");
      assert.equal(summary.model, model);
      assert.equal(summary.limitMicroUsd, 500_000);
      assert.equal(
        summary.reservationMicroUsd,
        summaryReservationMicroUsd(summaryPolicy(model, proof.budgets.legacySummary)),
      );
      return;
    }
    const [otherOwner] = await tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .limit(1);
    assert.ok(
      !otherOwner,
      "Dedicated acceptance DB already contains another seed; do not mint a new allowance.",
    );
    await tx.insert(schema.userProfiles).values(proof.principal);
    await tx.insert(schema.workspaces).values({
      id: proof.workspaceId,
      ownerId: proof.principal.id,
      name: "Synthetic platform acceptance",
    });
    await tx.insert(schema.workspaceMemberships).values({
      workspaceId: proof.workspaceId,
      userId: proof.principal.id,
      role: "owner",
    });
    // Source checked 2026-11-25. Schema intentionally has no source URL field;
    // its immutable provenance is retained in the fixed manifest and this file.
    await tx.insert(inferenceRates).values({
      id: proof.rateVersionId,
      provider: "workers-ai",
      model,
      currency: "USD",
      inputMicroUsdPerMillionTokens: 300_000,
      outputMicroUsdPerMillionTokens: 1_200_000,
    });
    await tx.insert(inferenceBudgets).values(
      [
        { id: proof.budgets.chat, limitMicroUsd: 1_000_000 },
        { id: proof.budgets.research, limitMicroUsd: 500_000 },
      ].map((budget) => ({
        ...budget,
        workspaceId: proof.workspaceId,
        rateVersionId: proof.rateVersionId,
        approvedAt: new Date(),
      })),
    );
    await tx.insert(schema.summaryInferenceBudgets).values({
      id: proof.budgets.legacySummary,
      model,
      limitMicroUsd: 500_000,
      reservationMicroUsd: summaryReservationMicroUsd(
        summaryPolicy(model, proof.budgets.legacySummary),
      ),
    });
    const workspace = createWorkspaceRepository(tx);
    await workspace.saveNote(proof.principal, proof.workspaceId, {
      id: proof.noteId,
      commandId: proof.noteCommandId,
      expectedRevision: 0,
      content: { title: "Synthetic Maple pilot meeting", transcript: "" },
    });
    await tx.insert(schema.recordings).values({
      workspaceId: proof.workspaceId,
      id: proof.recordingId,
      noteId: proof.noteId,
      actorId: proof.principal.id,
      sha256: "a".repeat(64),
      bytes: 1,
      mimeType: "audio/webm",
      durationSeconds: 45,
      objectKey: "synthetic/no-audio",
      status: "ready",
    });
    await tx.insert(schema.processingRuns).values({
      workspaceId: proof.workspaceId,
      id: proof.runId,
      noteId: proof.noteId,
      recordingId: proof.recordingId,
      actorId: proof.principal.id,
      config: { model: "synthetic", transcriptionModel: "synthetic" },
      status: "submitted",
      providerJobId: proof.runId,
    });
    await createRecordingRepository(tx).publish(
      proof.workspaceId,
      proof.runId,
      "synthetic/no-provider",
      [
        {
          start: 0,
          end: 12,
          speaker: "SPEAKER_00",
          text: "We decided to run the Maple pilot with five volunteers. I will send the invitation on November 27, 2026.",
        },
        {
          start: 13,
          end: 27,
          speaker: "SPEAKER_01",
          text: "I will review access permissions before the pilot. Do not invite customers until I confirm that review is complete.",
        },
        {
          start: 28,
          end: 44,
          speaker: "SPEAKER_00",
          text: "Agreed. The customer launch date is undecided. We still need to choose the owner for support.",
        },
      ],
    );
    const utterances = await tx
      .select()
      .from(schema.transcriptUtterances)
      .where(
        and(
          eq(schema.transcriptUtterances.workspaceId, proof.workspaceId),
          eq(schema.transcriptUtterances.runId, proof.runId),
        ),
      );
    assert.equal(utterances.length, 3);
    for (const contact of proof.contacts) {
      await workspace.savePerson(proof.principal, proof.workspaceId, {
        id: contact.id,
        commandId: contact.commandId,
        expectedRevision: 0,
        content: { displayName: contact.displayName, description: contact.description },
      });
      await createContactRepository(tx).save(proof.principal, {
        workspaceId: proof.workspaceId,
        personId: contact.id,
        operationId: contact.contactOperationId,
        expectedRevision: 0,
        fields: {
          organization: contact.organization,
          role: contact.role,
          links: contact.links,
        },
      });
      // A public research guest is not a fictional meeting participant.
      if (contact.track)
        await createTranscriptCorrectionRepository(tx).command(
          proof.principal,
          proof.workspaceId,
          proof.noteId,
          proof.runId,
          {
            kind: "assign",
            commandId: contact.attributionCommandId,
            targets: utterances
              .filter((turn) => turn.speakerLabel === contact.track)
              .map((turn) => ({ id: turn.id, expectedAttributionRevision: 0 })),
            assignment: { kind: "person", personId: contact.id },
          },
        );
    }
    await createAssistantRepository(tx).openThread(
      proof.principal,
      proof.workspaceId,
      proof.threadId,
      proof.noteId,
    );
    // Check normalized source publication, not merely a string in notes.transcript.
    const segments = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.transcriptSegments)
      .where(eq(schema.transcriptSegments.runId, proof.runId));
    assert.ok((segments[0]?.count ?? 0) > 0);
  });
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await client.end({ timeout: 5 });
}
