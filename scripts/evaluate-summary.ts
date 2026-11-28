import { open } from "node:fs/promises";
import { z } from "zod";

import { renderSummaryPrompt } from "../src/ai/summary/instructions";
import { summaryModelOutputSchema } from "../src/ai/summary/output";
import { summaryQualityFixtures } from "../tests/db/fixtures/summary-quality";
import {
  evaluateSummaryQuality,
  summaryQualityProvenance,
} from "../tests/db/fixtures/summary-quality-evaluation";
import type { SummaryQualitySubmission } from "../tests/db/fixtures/summary-quality-evaluation";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const label = z.string().trim().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const submissionSchema = z
  .object({
    submissionId: label,
    provenance: z
      .object({
        fixtureId: label,
        fixtureVersion: label,
        fixtureDigest: digest,
        contextDigest: digest,
        rubricVersion: label,
        rubricDigest: digest,
        criteriaDigest: digest,
        promptVersion: label,
        promptDigest: digest,
        schemaVersion: label,
        schemaDigest: digest,
      })
      .strict(),
    producer: z
      .object({
        kind: z.enum(["authored-control", "submitted-output"]),
        label,
        model: label.nullable(),
        runId: label.nullable(),
      })
      .strict(),
    // Malformed analysis is an evaluation result, not an invalid CLI envelope.
    output: z.json(),
  })
  .strict();

function fixture(id: string | undefined) {
  const found = summaryQualityFixtures.find((item) => item.id === id);
  if (!found) {
    throw new Error("Unknown case ID. Run bun run eval:summary --list.");
  }
  return found;
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

async function readSubmission(path: string) {
  const file = await open(path, "r");
  try {
    // Bound reads even if a file grows between opening and reading it.
    const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) {
        break;
      }
      length += result.bytesRead;
    }
    if (length > MAX_ARTIFACT_BYTES) {
      throw new Error("Summary artifact exceeds the 2 MiB input limit.");
    }
    let input: unknown;
    try {
      input = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } catch {
      throw new Error("Summary artifact must contain valid JSON.");
    }
    const parsed = submissionSchema.safeParse(input);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
      throw new Error(`Invalid submission envelope at: ${fields.join(", ")}.`);
    }
    return parsed.data;
  } finally {
    await file.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--list") {
    print(
      summaryQualityFixtures.map((item) => ({
        id: item.id,
        title: item.context.title,
        version: item.version,
        passages: item.context.passages.length,
      })),
    );
    return;
  }
  if (
    (args.length === 2 || args.length === 4) &&
    args[0] === "--case" &&
    (args.length === 2 || args[2] === "--prompt-version")
  ) {
    const source = fixture(args[1]);
    const promptVersion = args.length === 4 ? args[3]! : "summary-v1";
    const prompt = renderSummaryPrompt(promptVersion, source.context);
    // Export generation inputs without the authored answers or reviewer rubric.
    print({
      provenance: summaryQualityProvenance(source, promptVersion),
      system: prompt.system,
      user: prompt.user,
      // Provenance/evaluation describe the saved public projection. The model
      // receives its pinned model schema, including the newer private draft contracts.
      outputSchema: z.toJSONSchema(summaryModelOutputSchema(promptVersion)),
    });
    return;
  }
  if (args.length === 3 && args[0] === "--control") {
    const source = fixture(args[1]);
    const control = source.controls.find((item) => item.kind === args[2]);
    if (!control) {
      throw new Error("Control must be authored-positive or authored-adversarial.");
    }
    print({
      submissionId: `${source.id}/${control.id}`,
      provenance: summaryQualityProvenance(source),
      producer: {
        kind: "authored-control",
        label: control.description,
        model: null,
        runId: null,
      },
      output: control.output,
    } satisfies SummaryQualitySubmission);
    return;
  }
  if (args.length !== 1 || !args[0] || args[0].startsWith("--")) {
    throw new Error(
      "Usage: bun run eval:summary <artifact.json> | --list | --case <id> | --control <id> <kind>",
    );
  }
  const submission = await readSubmission(args[0]);
  const source = fixture(submission.provenance.fixtureId);
  const report = evaluateSummaryQuality(source, submission);
  const mechanical = [
    report.mechanical.context,
    report.mechanical.schema,
    report.mechanical.citations,
    report.mechanical.provenance,
  ].every((check) => check.status === "passed");
  const measurements = report.measurements;
  const concision =
    measurements !== null &&
    measurements.compressionCheck.passed === true &&
    measurements.sectionChecks.every((check) => check.passed);
  print({
    automatedChecks: mechanical && concision ? "passed" : "failed",
    ...report,
  });
  // A zero exit code is mechanical success only; semantic review is always pending.
  process.exitCode = mechanical && concision ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Summary evaluation failed.");
  process.exitCode = 2;
}
