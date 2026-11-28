import { isIP } from "node:net";

import type { ResearchPolicy } from "../../config/research";
import type { ResearchSource, SourceResearchProvider } from "./ports";

/** Transport must connect to exactly one of these validated addresses, retaining
 * the URL hostname for TLS verification. Ordinary fetch(url) is NOT an adapter. */
export interface PublicSourceTransport {
  resolve(hostname: string, signal: AbortSignal): Promise<string[]>;
  request(url: URL, addresses: string[], maxBytes: number, signal: AbortSignal): Promise<Response>;
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
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
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
      let url = publicResearchUrl(requestedUrl);

      const seen = new Set<string>();

      for (let redirects = 0; redirects <= policy.maxRedirects; redirects++) {
        signal.throwIfAborted();

        if (seen.has(url.href)) {
          throw new Error("Public source redirect loop.");
        }

        seen.add(url.href);
        const addresses = await transport.resolve(url.hostname, signal);

        if (
          !addresses.length ||
          addresses.length > 16 ||
          !addresses.every(isPublicResearchAddress)
        ) {
          throw new Error("Public source resolves to a prohibited address.");
        }

        const response = await transport.request(url, addresses, policy.maxSourceBytes, signal);

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");

          await response.body?.cancel();

          if (!location || redirects === policy.maxRedirects) {
            throw new Error("Public source redirect limit.");
          }

          url = publicResearchUrl(new URL(location, url).href);
          continue;
        }

        const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

        if (!response.ok || !type || !["text/plain", "text/html", "text/markdown"].includes(type)) {
          await response.body?.cancel();
          throw new Error("Public source is not supported text.");
        }

        const body = await readBoundedResearchBody(response, policy.maxSourceBytes, signal);

        const text = sourceText(body, type === "text/html");

        if (!text) {
          throw new Error("Public source has no extractable text.");
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

      throw new Error("Public source redirect limit.");
    },
  };
}
