export type ResearchSourceErrorCode =
  | "source_dns_lookup_failed"
  | "source_address_rejected"
  | "source_connect_failed"
  | "source_tls_failed"
  | "source_write_failed"
  | "source_read_failed"
  | "source_http_status_failed"
  | "source_content_type_unsupported"
  | "source_redirect_invalid"
  | "source_http_framing_invalid"
  | "source_body_failed"
  | "source_extract_failed"
  | "source_policy_invalid";

export type ResearchSourceErrorMetadata = {
  httpStatus?: number;
  contentTypeCategory?: "expected" | "missing" | "other";
  framingReason?: ResearchHttpFramingReason;
};

export type ResearchHttpFramingReason =
  | "header_terminator_missing"
  | "header_too_large"
  | "status_line_invalid"
  | "header_line_invalid"
  | "duplicate_framing_header"
  | "transfer_and_content_length"
  | "transfer_coding_unsupported"
  | "chunk_size_invalid"
  | "chunk_terminator_invalid"
  | "chunk_trailer_invalid"
  | "chunked_termination_missing"
  | "content_length_invalid"
  | "status_invalid";

const messages: Record<ResearchSourceErrorCode, string> = {
  source_dns_lookup_failed: "Research source DNS lookup failed.",
  source_address_rejected: "Research source address was rejected.",
  source_connect_failed: "Research source connection failed.",
  source_tls_failed: "Research source TLS verification failed.",
  source_write_failed: "Research source request write failed.",
  source_read_failed: "Research source response read failed.",
  source_http_status_failed: "Research source returned an unsuccessful HTTP status.",
  source_content_type_unsupported: "Research source content type is unsupported.",
  source_redirect_invalid: "Research source redirect was invalid.",
  source_http_framing_invalid: "Research source HTTP framing was invalid.",
  source_body_failed: "Research source response body was invalid.",
  source_extract_failed: "Research source text extraction failed.",
  source_policy_invalid: "Research source retrieval policy was invalid.",
};

/** Safe, stable diagnostic category; `cause` is retained only for internal handling. */
export class ResearchSourceError extends Error {
  readonly code: ResearchSourceErrorCode;
  readonly httpStatus?: number;
  readonly contentTypeCategory?: "expected" | "missing" | "other";
  readonly framingReason?: ResearchHttpFramingReason;

  constructor(
    code: ResearchSourceErrorCode,
    cause?: unknown,
    metadata?: ResearchSourceErrorMetadata,
  ) {
    super(messages[code], cause === undefined ? undefined : { cause });
    this.name = "ResearchSourceError";
    this.code = code;
    const httpStatus = metadata?.httpStatus;

    if (
      httpStatus !== undefined &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
    ) {
      this.httpStatus = httpStatus;
    }

    if (
      metadata?.contentTypeCategory === "expected" ||
      metadata?.contentTypeCategory === "missing" ||
      metadata?.contentTypeCategory === "other"
    ) {
      this.contentTypeCategory = metadata.contentTypeCategory;
    }

    if (
      metadata?.framingReason &&
      [
        "header_terminator_missing",
        "header_too_large",
        "status_line_invalid",
        "header_line_invalid",
        "duplicate_framing_header",
        "transfer_and_content_length",
        "transfer_coding_unsupported",
        "chunk_size_invalid",
        "chunk_terminator_invalid",
        "chunk_trailer_invalid",
        "chunked_termination_missing",
        "content_length_invalid",
        "status_invalid",
      ].includes(metadata.framingReason)
    ) {
      this.framingReason = metadata.framingReason;
    }
  }
}

export function researchSourceError(
  code: ResearchSourceErrorCode,
  cause?: unknown,
  metadata?: ResearchSourceErrorMetadata,
): ResearchSourceError {
  return cause instanceof ResearchSourceError
    ? cause
    : new ResearchSourceError(code, cause, metadata);
}
