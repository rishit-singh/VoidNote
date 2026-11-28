import assert from "node:assert/strict";
import { test } from "node:test";
import { connect as connectTls, type PeerCertificate } from "node:tls";
import { fileURLToPath, URL } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Native Node is an independent control: require normal CA/name validation and
// inspect its peer certificate. Never disable TLS or customize identity checks.
function nativeCertificate(ip: string, servername: string): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: ip, port: 443, servername, rejectUnauthorized: true }, () => {
      if (!socket.authorized) {
        reject(new Error("Native TLS was not authorized."));
      } else {
        resolve(socket.getPeerCertificate());
      }
      socket.end();
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error("Diagnostic TLS timeout.")));
    socket.once("error", reject);
  });
}

// Explicit, source-only network acceptance. Default runs never fetch live pages.
// This does not establish model semantics or hosted egress support.
void test(
  "real pinned-IP TLS rejects a valid mismatched hostname before HTTP, confirmed against the same native peer certificate",
  { skip: process.env.RESEARCH_SOURCE_TLS_PROBE !== "true", timeout: 60_000 },
  async () => {
    const bundle = await build({
      absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
      entryPoints: ["tests/worker/research-transport-live.fixture.ts"],
      tsconfig: "tsconfig.worker-tests.json",
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      conditions: ["workerd"],
      target: "es2022",
      external: ["node:*", "cloudflare:*"],
    });
    assert.ok(bundle.outputFiles[0]);
    const worker = new Miniflare({
      host: "127.0.0.1",
      port: 0,
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          config: {
            name: "research-source-tls-probe",
            compatibilityDate: "2026-11-13",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: bundle.outputFiles[0].text } },
            },
          },
        },
      ],
    });
    try {
      for (const path of ["/github", "/cloudflare"]) {
        const response = await worker.dispatchFetch(`http://localhost${path}`);
        assert.equal(response.status, 200);
        const result = (await response.json()) as {
          status: number;
          bytes: number;
          containsExpectedIdentityLink: boolean;
          mismatchRejected: boolean | null;
        };
        assert.equal(result.status, 200);
        assert.ok(result.bytes > 0 && result.bytes <= 48_000);
        assert.equal(result.containsExpectedIdentityLink, true);
        assert.equal(result.mismatchRejected, path === "/github" ? true : null);
      }
      const response = await worker.dispatchFetch("http://localhost/certificate-check");
      assert.equal(response.status, 200);
      const result = (await response.json()) as {
        ip: string;
        correct: { accepted: boolean; stage: string; httpBytesWritten: number };
        wrong: { accepted: boolean; stage: string; httpBytesWritten: number };
      };
      assert.deepEqual(result.correct, { accepted: true, stage: "tls", httpBytesWritten: 0 });
      assert.deepEqual(result.wrong, { accepted: false, stage: "tls", httpBytesWritten: 0 });
      const correctCertificate = await nativeCertificate(result.ip, "raw.githubusercontent.com");
      assert.ok(correctCertificate.fingerprint256);
      await assert.rejects(nativeCertificate(result.ip, "example.com"), (error: unknown) => {
        assert.ok(error instanceof Error);
        const tlsError = error as Error & { code?: string; cert?: PeerCertificate };
        assert.equal(tlsError.code, "ERR_TLS_CERT_ALTNAME_INVALID");
        assert.ok(tlsError.cert);
        assert.equal(tlsError.cert.fingerprint256, correctCertificate.fingerprint256);
        return true;
      });
    } finally {
      await worker.dispose();
    }
  },
);
