import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { SummaryQualityEvaluation } from "./fixtures/summary-quality-evaluation";

const script = fileURLToPath(new URL("../../scripts/evaluate-summary.ts", import.meta.url));
const caseId = "conditional-decision";

function run(...args: string[]) {
  const result = spawnSync("bun", [script, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  return result;
}

function control() {
  const result = run("--control", caseId, "authored-positive");
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    provenance: { fixtureDigest: string };
    output: {
      quickSummary: { text: string; citations: { evidenceId: string; quote: string }[] }[];
    };
  };
}

void describe("offline summary artifact command", () => {
  void it("exports generation inputs without leaking authored answers or evaluation rubrics", () => {
    const listed = run("--list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal((JSON.parse(listed.stdout) as unknown[]).length, 4);
    const exported = run("--case", caseId);
    assert.equal(exported.status, 0, exported.stderr);
    const packet = JSON.parse(exported.stdout) as {
      provenance: { promptDigest: string };
      system: string;
      user: string;
    };
    assert.deepEqual(Object.keys(packet), ["provenance", "system", "user", "outputSchema"]);
    assert.equal(typeof packet.system, "string");
    assert.equal(typeof packet.user, "string");
    const selected = run("--case", caseId, "--prompt-version", "summary-v3");
    assert.equal(selected.status, 0, selected.stderr);
    const selectedPacket = JSON.parse(selected.stdout) as {
      provenance: { promptVersion: string; promptDigest: string };
      system: string;
    };
    assert.equal(selectedPacket.provenance.promptVersion, "summary-v3");
    assert.notEqual(selectedPacket.provenance.promptDigest, packet.provenance.promptDigest);
    assert.match(selectedPacket.system, /summary-v3/);
    const draftExport = run("--case", caseId, "--prompt-version", "summary-v5");
    assert.equal(draftExport.status, 0, draftExport.stderr);
    const draftPacket = JSON.parse(draftExport.stdout) as {
      provenance: { promptVersion: string };
      outputSchema: { required: string[] };
    };
    assert.equal(draftPacket.provenance.promptVersion, "summary-v5");
    assert.ok(draftPacket.outputSchema.required.includes("claims"));
    assert.ok(!draftPacket.outputSchema.required.includes("memoryCandidates"));
    const v6Export = run("--case", caseId, "--prompt-version", "summary-v6");
    assert.equal(v6Export.status, 0, v6Export.stderr);
    const v6Packet = JSON.parse(v6Export.stdout) as {
      provenance: { promptVersion: string };
      outputSchema: { required: string[]; properties: { decisions: { description: string } } };
    };
    assert.equal(v6Packet.provenance.promptVersion, "summary-v6");
    assert.ok(v6Packet.outputSchema.required.includes("claims"));
    assert.match(v6Packet.outputSchema.properties.decisions.description, /claims/);
    const v7Export = run("--case", caseId, "--prompt-version", "summary-v7");
    assert.equal(v7Export.status, 0, v7Export.stderr);
    const v7Packet = JSON.parse(v7Export.stdout) as {
      provenance: { promptVersion: string };
      user: string;
      outputSchema: { required: string[] };
    };
    assert.equal(v7Packet.provenance.promptVersion, "summary-v7");
    assert.match(
      v7Packet.user,
      /Maximum combined quickSummary \+ detailedSummary prose: \d+ words/,
    );
    assert.ok(v7Packet.outputSchema.required.includes("claims"));
    assert.equal(run("--case", caseId, "--prompt-version", "unknown").status, 2);
    assert.equal(run("--case", "missing").status, 2);
    assert.equal(run("--control", caseId, "unknown").status, 2);
  });

  void it("keeps even a citation-valid adversarial artifact review-required on zero exit", (t) => {
    const directory = mkdtempSync(join(tmpdir(), "voidnote-quality-cli-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "artifact.json");
    for (const kind of ["authored-positive", "authored-adversarial"]) {
      const authored = run("--control", caseId, kind);
      assert.equal(authored.status, 0, authored.stderr);
      writeFileSync(path, authored.stdout);
      const evaluated = run(path);
      assert.equal(evaluated.status, 0, evaluated.stderr);
      const report = JSON.parse(evaluated.stdout) as {
        automatedChecks: string;
        semanticReview: { status: string };
        producer: { kind: string; model: null };
      };
      assert.equal(report.automatedChecks, "passed");
      assert.equal(report.semanticReview.status, "review-required");
      assert.equal(report.producer.kind, "authored-control");
      assert.equal(report.producer.model, null);
    }
  });

  void it(
    "distinguishes failed checks from invalid or oversized artifact envelopes",
    { timeout: 30_000 },
    (t) => {
      const directory = mkdtempSync(join(tmpdir(), "voidnote-quality-cli-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const path = join(directory, "artifact.json");
      const input = control();
      input.provenance.fixtureDigest = "0".repeat(64);
      writeFileSync(path, JSON.stringify(input));
      const stale = run(path);
      assert.equal(stale.status, 1);
      const staleReport = JSON.parse(stale.stdout) as SummaryQualityEvaluation;
      assert.equal(staleReport.mechanical.provenance.status, "failed");

      const invalidQuote = control();
      invalidQuote.output.quickSummary[0]!.citations[0]!.quote = "Not in this conversation.";
      writeFileSync(path, JSON.stringify(invalidQuote));
      assert.equal(run(path).status, 1);

      const malformedOutput = { ...control(), output: null };
      writeFileSync(path, JSON.stringify(malformedOutput));
      const malformed = run(path);
      assert.equal(malformed.status, 1);
      const malformedReport = JSON.parse(malformed.stdout) as SummaryQualityEvaluation;
      assert.equal(malformedReport.mechanical.schema.status, "failed");

      for (const contents of ["{", "{}", JSON.stringify({ ...control(), unrecognized: true })]) {
        writeFileSync(path, contents);
        const result = run(path);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
      }
      writeFileSync(path, " ".repeat(2 * 1024 * 1024 + 1));
      const oversized = run(path);
      assert.equal(oversized.status, 2);
      assert.match(oversized.stderr, /2 MiB/);
    },
  );
});
