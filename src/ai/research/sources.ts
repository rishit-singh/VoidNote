import { isIP } from "node:net";

import type { ResearchPolicy } from "../../config/research";
import type { ResearchSource, SourceResearchProvider } from "./ports";
import { ResearchSourceError, researchSourceError } from "./source-errors";

/** Transport must connect to exactly one of these validated addresses, retaining
 * the URL hostname for TLS verification. Ordinary fetch(url) is NOT an adapter. */
export interface PublicSourceTransport {
  resolve(hostname: string, signal: AbortSignal): Promise<string[]>;
  request(
    url: URL,
    addresses: string[],
    maxResponseBytes: number,
    signal: AbortSignal,
  ): Promise<Response>;
}

export function isPublicResearchAddress(address: string): boolean {
  // Initial adapter intentionally supports public IPv4 only. Rejecting IPv6
  // avoids mapped/translation/scope escape routes until a pinned v6 adapter exists.
  if (isIP(address) !== 4) {
    return false;
  }

  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      ((b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function publicResearchUrl(value: string): URL {
  if (value.length > 2048) {
    throw new Error("Source URL is too long.");
  }

  const url = new URL(value);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname) ||
    /\.(?:localhost|local|internal|test|invalid|example|onion)$/i.test(url.hostname)
  ) {
    throw new Error("Research requires a public HTTPS hostname without credentials.");
  }

  url.hash = "";

  return url;
}

export async function readBoundedResearchBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
) {
  const declared = response.headers.get("content-length");

  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel();
    throw new Error("Public source exceeds the byte limit.");
  }

  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Public source has no body.");
  }

  const parts: Uint8Array[] = [];

  let size = 0;

  const abort = () => {
    void reader.cancel().catch(() => {});
  };

  signal.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();

      if (next.done) {
        break;
      }

      size += next.value.byteLength;

      if (size > maxBytes) {
        throw new Error("Public source exceeds the byte limit.");
      }

      parts.push(next.value);
    }

    signal.throwIfAborted();
    const body = new Uint8Array(size);

    let offset = 0;

    for (const part of parts) {
      body.set(part, offset);
      offset += part.byteLength;
    }

    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function sourceText(body: string, html: boolean) {
  if (!html) {
    return body.trim();
  }

  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (entity) => {
      const decoded: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&nbsp;": " ",
      };

      return decoded[entity.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

export function createPublicUrlResearchProvider(
  transport: PublicSourceTransport,
): SourceResearchProvider {
  return {
    async retrieve(
      requestedUrl: string,
      policy: ResearchPolicy,
      signal: AbortSignal,
    ): Promise<ResearchSource> {
      let url: URL;

      try {
        url = publicResearchUrl(requestedUrl);
      } catch (error) {
        throw researchSourceError("source_address_rejected", error);
      }

      const seen = new Set<string>();

      for (let redirects = 0; redirects <= policy.maxRedirects; redirects++) {
        signal.throwIfAborted();

        if (seen.has(url.href)) {
          throw new ResearchSourceError("source_http_failed");
        }

        seen.add(url.href);
        let addresses: string[];

        try {
          addresses = await transport.resolve(url.hostname, signal);
        } catch (error) {
          if (signal.aborted && error instanceof Error) {
            throw error;
          }

          throw researchSourceError("source_dns_lookup_failed", error);
        }

        if (
          !addresses.length ||
          addresses.length > 16 ||
          !addresses.every(isPublicResearchAddress)
        ) {
          throw new ResearchSourceError("source_address_rejected");
        }

        let response: Response;

        try {
          response = await transport.request(url, addresses, policy.maxResponseBytes, signal);
        } catch (error) {
          if (signal.aborted && error instanceof Error) {
            throw error;
          }

          throw researchSourceError("source_connect_failed", error);
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");

          await response.body?.cancel();

          if (!location || redirects === policy.maxRedirects) {
            throw new ResearchSourceError("source_http_failed");
          }

          try {
            url = publicResearchUrl(new URL(location, url).href);
          } catch (error) {
            throw researchSourceError("source_http_failed", error);
          }

          continue;
        }

        const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

        if (!response.ok || !type || !["text/plain", "text/html", "text/markdown"].includes(type)) {
          await response.body?.cancel();
          throw new ResearchSourceError("source_http_failed");
        }

        let body: string;

        try {
          body = await readBoundedResearchBody(response, policy.maxResponseBytes, signal);
        } catch (error) {
          if (signal.aborted && error instanceof Error) {
            throw error;
          }

          throw researchSourceError("source_body_failed", error);
        }

        const text = sourceText(body, type === "text/html");

        if (!text) {
          throw new ResearchSourceError("source_extract_failed");
        }

        if (new TextEncoder().encode(text).byteLength > policy.maxSourceBytes) {
          throw new ResearchSourceError("source_extract_failed");
        }

        const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

        const digest = Array.from(new Uint8Array(digestBytes), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");

        return {
          id: crypto.randomUUID(),
          requestedUrl,
          url: url.href,
          text,
          digest,
          retrievedAt: new Date().toISOString(),
        };
      }

      throw new ResearchSourceError("source_http_failed");
    },
  };
}
