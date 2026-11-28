import { z } from "zod";

import { DEFAULT_RESEARCH_MAX_RESPONSE_BYTES } from "../../config/research";
import {
  type ResearchHttpFramingReason,
  ResearchSourceError,
  researchSourceError,
} from "./source-errors";
import {
  isPublicResearchAddress,
  type PublicSourceTransport,
  readBoundedResearchBody,
} from "./sources";

const HEADER_BYTES = 16_384;

function invalidFraming(framingReason: ResearchHttpFramingReason): ResearchSourceError {
  return new ResearchSourceError("source_http_framing_invalid", undefined, { framingReason });
}

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

  if (separator < 0) {
    throw new ResearchSourceError("source_http_framing_invalid", undefined, {
      framingReason: "header_terminator_missing",
      responseByteCount: bytes.byteLength,
    });
  }

  if (separator > HEADER_BYTES) {
    throw invalidFraming("header_too_large");
  }

  const lines = wire.slice(0, separator).split("\r\n");

  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines.shift() ?? "");

  if (!status) {
    throw invalidFraming("status_line_invalid");
  }

  const headers = new Headers();

  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);

    if (!match?.[1] || match[2] === undefined) {
      throw invalidFraming("header_line_invalid");
    }

    const name = match[1].toLowerCase();

    if ((name === "content-length" || name === "transfer-encoding") && headers.has(name)) {
      throw invalidFraming("duplicate_framing_header");
    }

    // Cookies are neither sent nor persisted.
    if (name !== "set-cookie") {
      try {
        headers.append(name, match[2]);
      } catch {
        throw invalidFraming("header_line_invalid");
      }
    }
  }

  const encoding = headers.get("content-encoding");

  if (encoding && encoding !== "identity") {
    throw new ResearchSourceError("source_body_failed");
  }

  const transfer = headers.get("transfer-encoding");

  const length = headers.get("content-length");

  if (transfer && length) {
    throw invalidFraming("transfer_and_content_length");
  }

  let body = bytes.slice(separator + 4);

  if (transfer) {
    if (transfer.toLowerCase() !== "chunked") {
      throw invalidFraming("transfer_coding_unsupported");
    }

    const chunks: Uint8Array[] = [];

    let offset = 0;

    let size = 0;

    let terminated = false;

    while (offset < body.length) {
      const lineEnd = body.indexOf(13, offset);

      if (lineEnd < 0 || body[lineEnd + 1] !== 10 || lineEnd - offset > 100) {
        throw invalidFraming("chunk_size_invalid");
      }

      const hex = new TextDecoder().decode(body.slice(offset, lineEnd)).split(";")[0] ?? "";

      if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) {
        throw invalidFraming("chunk_size_invalid");
      }

      const chunkSize = parseInt(hex, 16);

      offset = lineEnd + 2;

      if (chunkSize === 0) {
        if (body[offset] !== 13 || body[offset + 1] !== 10 || offset + 2 !== body.length) {
          throw invalidFraming("chunk_trailer_invalid");
        }

        terminated = true;
        break;
      }

      size += chunkSize;

      if (size > maxResponseBytes) {
        throw new ResearchSourceError("source_body_failed");
      }

      if (
        offset + chunkSize + 2 > body.length ||
        body[offset + chunkSize] !== 13 ||
        body[offset + chunkSize + 1] !== 10
      ) {
        throw invalidFraming("chunk_terminator_invalid");
      }

      chunks.push(body.slice(offset, offset + chunkSize));
      offset += chunkSize + 2;
    }

    if (!terminated) {
      throw invalidFraming("chunked_termination_missing");
    }

    body = new Uint8Array(size);
    let cursor = 0;

    for (const chunk of chunks) {
      body.set(chunk, cursor);
      cursor += chunk.length;
    }

    headers.delete("transfer-encoding");
  } else if (length && (!/^\d+$/.test(length) || Number(length) !== body.length)) {
    throw invalidFraming("content_length_invalid");
  }

  if (body.length > maxResponseBytes) {
    throw new ResearchSourceError("source_body_failed");
  }

  headers.set("content-length", String(body.length));
  const code = Number(status[1]);

  if (code < 100 || code > 599) {
    throw invalidFraming("status_invalid");
  }

  if (code < 200) {
    throw new ResearchSourceError("source_http_status_failed", undefined, {
      httpStatus: code,
    });
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
      try {
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
          throw new ResearchSourceError("source_dns_lookup_failed");
        }

        // Fixed trusted DNS endpoint; no user-controlled URL is passed to fetch.
        const text = await readBoundedResearchBody(response, 32_768, signal);

        const result = dnsResponseSchema.parse(JSON.parse(text));

        return (result.Answer ?? [])
          .filter((answer) => answer.type === 1)
          .map((answer) => answer.data);
      } catch (error) {
        if (signal.aborted && error instanceof Error) {
          throw error;
        }

        throw researchSourceError("source_dns_lookup_failed", error);
      }
    },
    async request(url, addresses, maxResponseBytes, signal) {
      if (
        !Number.isSafeInteger(maxResponseBytes) ||
        maxResponseBytes < 1 ||
        maxResponseBytes > DEFAULT_RESEARCH_MAX_RESPONSE_BYTES
      ) {
        throw new ResearchSourceError("source_policy_invalid");
      }

      const address = addresses[0];

      if (!address || !addresses.every(isPublicResearchAddress)) {
        throw new ResearchSourceError("source_address_rejected");
      }

      signal.throwIfAborted();
      // Keep the Workers-only socket import behind retrieval for Node/OpenNext.
      const plain = await (async () => {
        try {
          const { connect } = await import("cloudflare:sockets");

          signal.throwIfAborted();

          return connect(
            { hostname: address, port: 443 },
            { secureTransport: "starttls", allowHalfOpen: false },
          );
        } catch (error) {
          if (signal.aborted && error instanceof Error) {
            throw error;
          }

          throw researchSourceError("source_connect_failed", error);
        }
      })();

      void plain.closed.catch(() => {});
      let socket = plain;

      const abort = () => {
        void socket.close().catch(() => {});
      };

      signal.addEventListener("abort", abort, { once: true });

      try {
        try {
          await plain.opened;
        } catch (error) {
          if (signal.aborted && error instanceof Error) {
            throw error;
          }

          throw researchSourceError("source_connect_failed", error);
        }

        signal.throwIfAborted();

        // This is a startTls option, not a connect option. Do not omit it even
        // when a runtime warns/rejects: the IP certificate is not the URL identity.
        try {
          socket = plain.startTls({ expectedServerHostname: url.hostname });
          void socket.closed.catch(() => {});
          await socket.opened;
        } catch (error) {
          if (signal.aborted && error instanceof Error) {
            throw error;
          }

          throw researchSourceError("source_tls_failed", error);
        }

        signal.throwIfAborted();
        let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;

        try {
          writer = socket.writable.getWriter();
          await writer.write(
            new TextEncoder().encode(
              `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nAccept: text/html,text/plain,text/markdown\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: VoidNote-Research/1.0\r\n\r\n`,
            ),
          );
        } catch (error) {
          if (signal.aborted && error instanceof Error) {
            throw error;
          }

          throw researchSourceError("source_write_failed", error);
        } finally {
          writer?.releaseLock();
        }

        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

        const parts: Uint8Array[] = [];

        let size = 0;

        try {
          reader = socket.readable.getReader();

          while (true) {
            signal.throwIfAborted();
            const next = await reader.read();

            if (next.done) {
              break;
            }

            size += next.value.byteLength;

            // Bound framing overhead as well as the decoded HTTP entity.
            if (size > HEADER_BYTES + maxResponseBytes * 2) {
              throw new ResearchSourceError("source_body_failed");
            }

            parts.push(next.value);
          }
        } catch (error) {
          if (signal.aborted && error instanceof Error) {
            throw error;
          }

          throw researchSourceError("source_read_failed", error);
        } finally {
          reader?.releaseLock();
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
