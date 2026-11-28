export type ResearchSourceErrorCode =
  | "source_dns_lookup_failed"
  | "source_address_rejected"
  | "source_connect_failed"
  | "source_tls_failed"
  | "source_write_failed"
  | "source_read_failed"
  | "source_http_failed"
  | "source_body_failed"
  | "source_extract_failed"
  | "source_policy_invalid";

const messages: Record<ResearchSourceErrorCode, string> = {
  source_dns_lookup_failed: "Research source DNS lookup failed.",
  source_address_rejected: "Research source address was rejected.",
  source_connect_failed: "Research source connection failed.",
  source_tls_failed: "Research source TLS verification failed.",
  source_write_failed: "Research source request write failed.",
  source_read_failed: "Research source response read failed.",
  source_http_failed: "Research source HTTP response was invalid.",
  source_body_failed: "Research source response body was invalid.",
  source_extract_failed: "Research source text extraction failed.",
  source_policy_invalid: "Research source retrieval policy was invalid.",
};

/** Safe, stable diagnostic category; `cause` is retained only for internal handling. */
export class ResearchSourceError extends Error {
  readonly code: ResearchSourceErrorCode;

  constructor(code: ResearchSourceErrorCode, cause?: unknown) {
    super(messages[code], cause === undefined ? undefined : { cause });
    this.name = "ResearchSourceError";
    this.code = code;
  }
}

export function researchSourceError(
  code: ResearchSourceErrorCode,
  cause?: unknown,
): ResearchSourceError {
  return cause instanceof ResearchSourceError ? cause : new ResearchSourceError(code, cause);
}
