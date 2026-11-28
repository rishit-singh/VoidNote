import { connect } from "cloudflare:sockets";

import { isPublicResearchAddress } from "../../src/ai/research/sources";
import { createWorkerPublicSourceTransport } from "../../src/ai/research/worker-transport";

async function handshakeOnly(ip: string, hostname: string, signal: AbortSignal) {
  if (!isPublicResearchAddress(ip)) throw new Error("Invalid diagnostic destination.");
  let socket = connect(
    { hostname: ip, port: 443 },
    { secureTransport: "starttls", allowHalfOpen: false },
  );
  void socket.closed.catch(() => {});
  const abort = () => {
    void socket.close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await socket.opened;
    signal.throwIfAborted();
    try {
      socket = socket.startTls({ expectedServerHostname: hostname });
      void socket.closed.catch(() => {});
      await socket.opened;
      return { accepted: true, stage: "tls", httpBytesWritten: 0 };
    } catch {
      signal.throwIfAborted();
      return { accepted: false, stage: "tls", httpBytesWritten: 0 };
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await socket.close().catch(() => {});
  }
}

// Source-only diagnostic: no model binding, database or application command.
const fixture = {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const source = new URL(
      path === "/cloudflare"
        ? "https://simonwillison.net/about/"
        : "https://raw.githubusercontent.com/simonw/simonw/main/README.md",
    );
    const transport = createWorkerPublicSourceTransport();
    const signal = AbortSignal.timeout(15_000);
    const addresses = await transport.resolve(source.hostname, signal);
    if (path === "/certificate-check") {
      const ip = addresses[0];
      if (!ip) throw new Error("Diagnostic DNS returned no address.");
      return Response.json({
        ip,
        correct: await handshakeOnly(ip, source.hostname, signal),
        // This name exists publicly; only the pinned GitHub IP is connected.
        wrong: await handshakeOnly(ip, "example.com", signal),
      });
    }
    const response = await transport.request(source, addresses, 48_000, signal);
    const text = await response.text();

    // Probe the production request method too. GitHub serves a certificate not
    // covering example.com; native Node separately confirms the same fingerprint.
    let mismatchRejected: boolean | null = null;
    if (path === "/github") {
      mismatchRejected = false;
      try {
        const mismatch = await transport.request(
          new URL("https://example.com/"),
          addresses,
          48_000,
          signal,
        );
        await mismatch.body?.cancel();
      } catch {
        signal.throwIfAborted();
        mismatchRejected = true;
      }
    }
    return Response.json({
      status: response.status,
      source: source.href,
      bytes: new TextEncoder().encode(text).byteLength,
      containsExpectedIdentityLink: text.includes("simonwillison.net"),
      mismatchRejected,
    });
  },
};

export default fixture;
