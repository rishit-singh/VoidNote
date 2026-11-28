import { z } from "zod";

import { DEFAULT_RESEARCH_MAX_RESPONSE_BYTES } from "../../config/research";
import {
  isPublicResearchAddress,
  type PublicSourceTransport,
  readBoundedResearchBody,
} from "./sources";

const HEADER_BYTES = 16_384;

const dnsResponseSchema = z.object({
  Status: z.literal(0),
  Answer: z
    .array(z.object({ type: z.number(), data: z.string() }))
    .max(32)
    .optional(),
});

/** Minimal bounded HTTP/1.1 reader. Request uses Connection: close and identity
 * encoding; unsupported framing fails closed rather than guessing body boundaries. */
export function parseResearchHttpResponse(bytes: Uint8Array, maxResponseBytes: number): Response {
  const wire = new TextDecoder("latin1").decode(bytes);

  const separator = wire.indexOf("\r\n\r\n");

  if (separator < 0 || separator > HEADER_BYTES) {
    throw new Error("Invalid source HTTP headers.");
  }

  const lines = wire.slice(0, separator).split("\r\n");

  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines.shift() ?? "");

  if (!status) {
    throw new Error("Invalid source HTTP status.");
  }

  const headers = new Headers();

  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);

    if (!match?.[1] || match[2] === undefined) {
      throw new Error("Invalid source HTTP header.");
    }

    const name = match[1].toLowerCase();

    if ((name === "content-length" || name === "transfer-encoding") && headers.has(name)) {
      throw new Error("Ambiguous source HTTP framing.");
    }

    // Cookies are neither sent nor persisted.
    if (name !== "set-cookie") {
      headers.append(name, match[2]);
    }
  }

  const encoding = headers.get("content-encoding");

  if (encoding && encoding !== "identity") {
    throw new Error("Compressed source responses are not supported.");
  }

  const transfer = headers.get("transfer-encoding");

  const length = headers.get("content-length");

  if (transfer && length) {
    throw new Error("Ambiguous source HTTP framing.");
  }

  let body = bytes.slice(separator + 4);

  if (transfer) {
    if (transfer.toLowerCase() !== "chunked") {
      throw new Error("Unsupported source HTTP transfer.");
    }

    const chunks: Uint8Array[] = [];

    let offset = 0;

    let size = 0;

    let terminated = false;

    while (offset < body.length) {
      const lineEnd = body.indexOf(13, offset);

      if (lineEnd < 0 || body[lineEnd + 1] !== 10 || lineEnd - offset > 100) {
        throw new Error("Invalid chunk header.");
      }

      const hex = new TextDecoder().decode(body.slice(offset, lineEnd)).split(";")[0] ?? "";

      if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) {
        throw new Error("Invalid chunk length.");
      }

      const chunkSize = parseInt(hex, 16);

      offset = lineEnd + 2;

      if (chunkSize === 0) {
        if (body[offset] !== 13 || body[offset + 1] !== 10 || offset + 2 !== body.length) {
          throw new Error("Incomplete or unsupported source HTTP trailers.");
        }

        terminated = true;
        break;
      }

      size += chunkSize;

      if (
        size > maxResponseBytes ||
        offset + chunkSize + 2 > body.length ||
        body[offset + chunkSize] !== 13 ||
        body[offset + chunkSize + 1] !== 10
      ) {
        throw new Error("Source chunk exceeds the bounded body.");
      }

      chunks.push(body.slice(offset, offset + chunkSize));
      offset += chunkSize + 2;
    }

    if (!terminated) {
      throw new Error("Source chunks were interrupted.");
    }

    body = new Uint8Array(size);
    let cursor = 0;

    for (const chunk of chunks) {
      body.set(chunk, cursor);
      cursor += chunk.length;
    }

    headers.delete("transfer-encoding");
  } else if (length && (!/^\d+$/.test(length) || Number(length) !== body.length)) {
    throw new Error("Source body was interrupted.");
  }

  if (body.length > maxResponseBytes) {
    throw new Error("Source body exceeds the byte limit.");
  }

  headers.set("content-length", String(body.length));
  const code = Number(status[1]);

  if (code < 200 || code > 599) {
    throw new Error("Unsupported source HTTP status.");
  }

  return new Response([204, 205, 304].includes(code) ? null : body, { status: code, headers });
}

/** Connect to the validated IP, then verify the original hostname through
 * startTls BEFORE writing HTTP bytes. Installed workerd rejects a valid but
 * certificate-mismatched hostname on a fixed GitHub IP (native Node confirms the
 * same peer certificate for both names). Its "unsupported" warning does not mean
 * the option is ignored: v1.20261113.1 passes it to the TLS starter. Some runtimes reject this option;
 * propagate that failure, never retry without it or fall back to unpinned fetch.
 * Hosted Workers also prohibit TCP egress to Cloudflare-proxied destinations. */
export function createWorkerPublicSourceTransport(): PublicSourceTransport {
  return {
    async resolve(hostname, signal) {
      const url = new URL("https://cloudflare-dns.com/dns-query");

      url.searchParams.set("name", hostname);
      url.searchParams.set("type", "A");
      const response = await fetch(url, {
        headers: { accept: "application/dns-json" },
        // workerd supports only follow/manual. Reject the trusted resolver's
        // redirects through the non-2xx guard below; never follow a new endpoint.
        redirect: "manual",
        signal,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Public source DNS lookup failed.");
      }

      // Fixed trusted DNS endpoint; no user-controlled URL is passed to fetch.
      const text = await readBoundedResearchBody(response, 32_768, signal);

      const result = dnsResponseSchema.parse(JSON.parse(text));

      return (result.Answer ?? [])
        .filter((answer) => answer.type === 1)
        .map((answer) => answer.data);
    },
    async request(url, addresses, maxResponseBytes, signal) {
      if (
        !Number.isSafeInteger(maxResponseBytes) ||
        maxResponseBytes < 1 ||
        maxResponseBytes > DEFAULT_RESEARCH_MAX_RESPONSE_BYTES
      ) {
        throw new Error("Source response byte limit is invalid.");
      }

      const address = addresses[0];

      if (!address || !addresses.every(isPublicResearchAddress)) {
        throw new Error("Unvalidated source address.");
      }

      signal.throwIfAborted();
      // Keep the Workers-only socket import behind retrieval for Node/OpenNext.
      const { connect } = await import("cloudflare:sockets");

      signal.throwIfAborted();
      const plain = connect(
        { hostname: address, port: 443 },
        { secureTransport: "starttls", allowHalfOpen: false },
      );

      void plain.closed.catch(() => {});
      let socket = plain;

      const abort = () => {
        void socket.close().catch(() => {});
      };

      signal.addEventListener("abort", abort, { once: true });

      try {
        await plain.opened;
        signal.throwIfAborted();
        // This is a startTls option, not a connect option. Do not omit it even
        // when a runtime warns/rejects: the IP certificate is not the URL identity.
        socket = plain.startTls({ expectedServerHostname: url.hostname });
        void socket.closed.catch(() => {});
        await socket.opened;
        signal.throwIfAborted();
        const writer = socket.writable.getWriter();

        try {
          await writer.write(
            new TextEncoder().encode(
              `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nAccept: text/html,text/plain,text/markdown\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: VoidNote-Research/1.0\r\n\r\n`,
            ),
          );
        } finally {
          writer.releaseLock();
        }

        const reader = socket.readable.getReader();

        const parts: Uint8Array[] = [];

        let size = 0;

        try {
          while (true) {
            signal.throwIfAborted();
            const next = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;

            if (next.done) {
              break;
            }

            size += next.value.byteLength;

            // Bound framing overhead as well as the decoded HTTP entity.
            if (size > HEADER_BYTES + maxResponseBytes * 2) {
              throw new Error("Source wire response exceeds the bound.");
            }

            parts.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }

        signal.throwIfAborted();
        const bytes = new Uint8Array(size);

        let offset = 0;

        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }

        return parseResearchHttpResponse(bytes, maxResponseBytes);
      } finally {
        signal.removeEventListener("abort", abort);
        await socket.close().catch(() => {});
      }
    },
  };
}
