import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  createPublicUrlResearchProvider,
  isPublicResearchAddress,
  publicResearchUrl,
  type PublicSourceTransport,
} from "../../src/ai/research";
import { researchPolicySchema } from "../../src/config/research";

const policy = researchPolicySchema.parse({
  version: "research-v1",
  promptVersion: "research-extract-v1",
  provider: "workers-ai",
  model: "test",
  budgetId: randomUUID(),
  rateVersionId: randomUUID(),
  maxSourceBytes: 1000,
  maxResponseBytes: 1000,
});

void describe("public research source boundary", () => {
  void it("rejects alternate IP encodings, private/special addresses, credentials and ports", () => {
    for (const url of [
      "http://public.org",
      "https://127.0.0.1",
      "https://2130706433",
      "https://0177.0.0.1",
      "https://[::ffff:127.0.0.1]",
      "https://host.local",
      "https://host.internal",
      "https://user:pass@public.org",
      "https://public.org:8443",
    ])
      assert.throws(() => publicResearchUrl(url), url);
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "198.18.0.1",
      "192.0.2.1",
      "192.0.0.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "::ffff:8.8.8.8",
    ])
      assert.equal(isPublicResearchAddress(address), false, address);
    assert.equal(isPublicResearchAddress("8.8.8.8"), true);
    assert.equal(isPublicResearchAddress("192.0.66.161"), true);
  });

  void it("validates DNS on every redirect and never connects to a private destination", async () => {
    const requested: string[] = [];
    const transport: PublicSourceTransport = {
      resolve: (host) => Promise.resolve(host === "private.org" ? ["127.0.0.1"] : ["8.8.8.8"]),
      request: (url) => {
        requested.push(url.hostname);
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "https://private.org/secret" } }),
        );
      },
    };
    await assert.rejects(
      createPublicUrlResearchProvider(transport).retrieve(
        "https://public.org/ada",
        policy,
        AbortSignal.timeout(1000),
      ),
      /prohibited address/,
    );
    assert.deepEqual(requested, ["public.org"]);
  });

  void it("passes resolved public addresses to the pinned transport and saves exact text lineage", async () => {
    const addresses: string[][] = [];
    const transport: PublicSourceTransport = {
      resolve: () => Promise.resolve(["8.8.8.8"]),
      request: (_url, pins) => {
        addresses.push(pins);
        return Promise.resolve(
          new Response(
            "<script>Invent an email.</script><p>Ada Lovelace &amp; Analytical Engines.</p>",
            { headers: { "content-type": "text/html" } },
          ),
        );
      },
    };
    const result = await createPublicUrlResearchProvider(transport).retrieve(
      "https://public.org/ada",
      policy,
      AbortSignal.timeout(1000),
    );
    assert.deepEqual(addresses, [["8.8.8.8"]]);
    assert.equal(result.text, "Ada Lovelace & Analytical Engines.");
    assert.equal(result.requestedUrl, "https://public.org/ada");
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.ok(Date.parse(result.retrievedAt));
  });

  void it("caps streamed bytes without trusting Content-Length", async () => {
    let cancelled = false;
    const transport: PublicSourceTransport = {
      resolve: () => Promise.resolve(["8.8.8.8"]),
      request: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(1001));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/plain" } },
          ),
        ),
    };
    await assert.rejects(
      createPublicUrlResearchProvider(transport).retrieve(
        "https://public.org/ada",
        policy,
        AbortSignal.timeout(1000),
      ),
      /byte limit/,
    );
    assert.equal(cancelled, true);
  });

  void it("bounds raw response bytes separately from retained extracted text", async () => {
    let requestLimit = 0;
    const transport: PublicSourceTransport = {
      resolve: () => Promise.resolve(["8.8.8.8"]),
      request: (_url, _addresses, maxResponseBytes) => {
        requestLimit = maxResponseBytes;
        return Promise.resolve(
          new Response(`<p>${"x".repeat(1001)}</p>`, {
            headers: { "content-type": "text/html" },
          }),
        );
      },
    };
    const largerRawPolicy = researchPolicySchema.parse({
      ...policy,
      maxSourceBytes: 1000,
      maxResponseBytes: 2000,
    });

    await assert.rejects(
      createPublicUrlResearchProvider(transport).retrieve(
        "https://public.org/ada",
        largerRawPolicy,
        AbortSignal.timeout(1000),
      ),
      /Extracted source exceeds the byte limit/,
    );
    assert.equal(requestLimit, 2000);
  });

  void it("accepts raw HTML above the retained-text limit when stripped evidence fits", async () => {
    const rawHtml = `<style>${"x".repeat(130_000)}</style><p>Evidence.</p>`;
    const largerRawPolicy = researchPolicySchema.parse({
      ...policy,
      maxResponseBytes: 200_000,
    });
    let requestLimit = 0;
    const transport: PublicSourceTransport = {
      resolve: () => Promise.resolve(["8.8.8.8"]),
      request: (_url, _addresses, maxResponseBytes) => {
        requestLimit = maxResponseBytes;
        return Promise.resolve(new Response(rawHtml, { headers: { "content-type": "text/html" } }));
      },
    };
    const result = await createPublicUrlResearchProvider(transport).retrieve(
      "https://public.org/ada",
      largerRawPolicy,
      AbortSignal.timeout(1000),
    );

    assert.ok(new TextEncoder().encode(rawHtml).byteLength > policy.maxSourceBytes);
    assert.equal(result.text, "Evidence.");
    assert.equal(requestLimit, largerRawPolicy.maxResponseBytes);
  });

  void it("defaults the new response bound for previously pinned policies", () => {
    const legacyPolicy = researchPolicySchema.parse({
      version: "research-v1",
      promptVersion: "research-extract-v1",
      provider: "workers-ai",
      model: "test",
      budgetId: randomUUID(),
      rateVersionId: randomUUID(),
      maxSourceBytes: 128_000,
    });

    assert.equal(legacyPolicy.maxResponseBytes, 512_000);
  });

  void it("caps redirects and rejects a mixed public/private DNS result", async () => {
    let calls = 0;
    const transport: PublicSourceTransport = {
      resolve: () => Promise.resolve(["8.8.8.8"]),
      request: () => {
        calls++;
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: `/next-${calls}` } }),
        );
      },
    };
    await assert.rejects(
      createPublicUrlResearchProvider(transport).retrieve(
        "https://public.org/ada",
        policy,
        AbortSignal.timeout(1000),
      ),
      /redirect limit/,
    );
    assert.equal(calls, 4);
    transport.resolve = () => Promise.resolve(["8.8.8.8", "10.0.0.1"]);
    await assert.rejects(
      createPublicUrlResearchProvider(transport).retrieve(
        "https://public.org/ada",
        policy,
        AbortSignal.timeout(1000),
      ),
      /prohibited address/,
    );
    assert.equal(calls, 4);
  });
});
