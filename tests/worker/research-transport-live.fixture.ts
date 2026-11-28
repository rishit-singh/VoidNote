import { connect } from "cloudflare:sockets";

import {
  createPublicUrlResearchProvider,
  isPublicResearchAddress,
  type PublicSourceTransport,
} from "../../src/ai/research/sources";
import {
  createWorkerPublicSourceTransport,
  parseResearchHttpResponse,
} from "../../src/ai/research/worker-transport";
import { researchPolicySchema } from "../../src/config/research";
import { ResearchSourceError } from "../../src/ai/research/source-errors";

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
      return { socketOpened: true, stage: "socket_opened", httpBytesWritten: 0 };
    } catch {
      signal.throwIfAborted();
      return { socketOpened: false, stage: "socket_open_failed", httpBytesWritten: 0 };
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await socket.close().catch(() => {});
  }
}

const NASA_CONTROL_URL = new URL("https://science.nasa.gov/mission/msl-curiosity/");
const MAX_CONTROL_BODY_BYTES = 512_000;
const MAX_CONTROL_WIRE_BYTES = 16_384 + MAX_CONTROL_BODY_BYTES * 2;

async function readNasaTlsControl(
  mode: "hostname-tls" | "pinned-starttls" | "pinned-mismatch-starttls",
) {
  const signal = AbortSignal.timeout(20_000);
  const transport = createWorkerPublicSourceTransport();
  let stage: "dns" | "connect" | "tls" | "write" | "read" | "parse" = "dns";
  let socket: Socket | undefined;
  const abort = () => {
    void socket?.close().catch(() => {});
  };

  signal.addEventListener("abort", abort, { once: true });

  try {
    const addresses = await transport.resolve(NASA_CONTROL_URL.hostname, signal);
    const address = addresses[0];

    if (!address || !addresses.every(isPublicResearchAddress)) {
      return { ok: false, mode, stage, reason: "address_rejected" } as const;
    }

    const hostnameTls = mode === "hostname-tls";
    stage = "connect";
    const plain = connect(
      hostnameTls
        ? { hostname: NASA_CONTROL_URL.hostname, port: 443 }
        : { hostname: address, port: 443 },
      {
        secureTransport: hostnameTls ? "on" : "starttls",
        allowHalfOpen: false,
      },
    );

    socket = plain;
    void plain.closed.catch(() => {});
    await plain.opened;
    signal.throwIfAborted();

    if (!hostnameTls) {
      stage = "tls";
      socket = plain.startTls({
        expectedServerHostname:
          mode === "pinned-mismatch-starttls"
            ? "voidnote-diagnostic.invalid"
            : NASA_CONTROL_URL.hostname,
      });
      void socket.closed.catch(() => {});
      await socket.opened;
      signal.throwIfAborted();
    }

    stage = "write";
    const writer = socket.writable.getWriter();

    try {
      await writer.write(
        new TextEncoder().encode(
          `GET ${NASA_CONTROL_URL.pathname}${NASA_CONTROL_URL.search} HTTP/1.1\r\nHost: ${NASA_CONTROL_URL.hostname}\r\nAccept: text/html,text/plain,text/markdown\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: VoidNote-Source-Diagnostic/1.0\r\n\r\n`,
        ),
      );
    } finally {
      writer.releaseLock();
    }

    stage = "read";
    const reader = (socket.readable as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    let responseByteCount = 0;

    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();

        if (next.done) {
          break;
        }

        responseByteCount += next.value.byteLength;

        if (responseByteCount > MAX_CONTROL_WIRE_BYTES) {
          return { ok: false, mode, stage, reason: "response_limit" } as const;
        }

        parts.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }

    const wire = new Uint8Array(responseByteCount);
    let offset = 0;

    for (const part of parts) {
      wire.set(part, offset);
      offset += part.byteLength;
    }

    stage = "parse";
    const response = parseResearchHttpResponse(wire, MAX_CONTROL_BODY_BYTES);
    const bodyByteCount = (await response.arrayBuffer()).byteLength;

    return {
      ok: true,
      mode,
      status: response.status,
      responseByteCount,
      bodyByteCount,
      ...(mode === "pinned-mismatch-starttls" ? { mismatchHttpResponse: true } : {}),
    } as const;
  } catch (error) {
    return {
      ok: false,
      mode,
      stage,
      error:
        error instanceof ResearchSourceError
          ? error.code
          : signal.aborted
            ? "timeout"
            : "socket_error",
      ...(error instanceof ResearchSourceError && error.framingReason
        ? { framingReason: error.framingReason }
        : {}),
      ...(error instanceof ResearchSourceError && error.responseByteCount !== undefined
        ? { responseByteCount: error.responseByteCount }
        : {}),
      ...(mode === "pinned-mismatch-starttls" ? { mismatchHttpResponse: false } : {}),
    } as const;
  } finally {
    signal.removeEventListener("abort", abort);
    await socket?.close().catch(() => {});
  }
}

// Source-only diagnostic: no model binding, database or application command.
const fixture = {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      path === "/control/hostname-tls" ||
      path === "/control/pinned-starttls" ||
      path === "/control/pinned-mismatch-http"
    ) {
      const mode =
        path === "/control/hostname-tls"
          ? "hostname-tls"
          : path === "/control/pinned-starttls"
            ? "pinned-starttls"
            : "pinned-mismatch-starttls";

      return Response.json(await readNasaTlsControl(mode));
    }

    if (path === "/nasa-curiosity" || path === "/nasa-perseverance") {
      const sourceUrl =
        path === "/nasa-curiosity"
          ? "https://science.nasa.gov/mission/msl-curiosity/"
          : "https://science.nasa.gov/mission/mars-2020-perseverance/";
      const baseTransport = createWorkerPublicSourceTransport();
      let rawResponseBytes = 0;
      const measuredTransport: PublicSourceTransport = {
        resolve: (hostname, signal) => baseTransport.resolve(hostname, signal),
        async request(url, addresses, maxResponseBytes, signal) {
          const response = await baseTransport.request(url, addresses, maxResponseBytes, signal);
          const body = await response.clone().arrayBuffer();
          rawResponseBytes = body.byteLength;
          return response;
        },
      };
      try {
        const result = await createPublicUrlResearchProvider(measuredTransport).retrieve(
          sourceUrl,
          researchPolicySchema.parse({
            version: "research-v1",
            promptVersion: "research-extract-v1",
            provider: "workers-ai",
            model: "diagnostic",
            budgetId: crypto.randomUUID(),
            rateVersionId: crypto.randomUUID(),
            maxSourceBytes: 128_000,
            maxResponseBytes: 512_000,
            maxRedirects: 3,
          }),
          AbortSignal.timeout(30_000),
        );
        return Response.json({
          status: 200,
          tlsAndHttpSucceeded: true,
          rawResponseBytes,
          extractedTextBytes: new TextEncoder().encode(result.text).byteLength,
        });
      } catch (error) {
        return Response.json({
          status: 502,
          tlsAndHttpSucceeded: false,
          rawResponseBytes,
          error: error instanceof ResearchSourceError ? error.code : "source_transport_failed",
          framingReason: error instanceof ResearchSourceError ? error.framingReason : undefined,
          responseByteCount:
            error instanceof ResearchSourceError ? error.responseByteCount : undefined,
        });
      }
    }
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
