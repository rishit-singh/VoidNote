import type { ResearchPolicy } from "../../config/research";
import type { ContactFields } from "../../contracts/contacts";
import type {
  ResearchFactRequest,
  ResearchFinding,
  ResearchPersonRequest,
  ResearchStatus,
} from "../../contracts/research";
import type { InferenceUsage } from "../inference";

export type ResearchSource = {
  id: string;
  requestedUrl: string;
  url: string;
  text: string;
  retrievedAt: string;
  digest: string;
};

/** Application-owned retrieval port. No discovery or paid search is implied. */
export interface SourceResearchProvider {
  retrieve(url: string, policy: ResearchPolicy, signal: AbortSignal): Promise<ResearchSource>;
}

export type ResearchDiscoveryInput = {
  person: ResearchExtractionInput["person"];
  facts: ResearchFactRequest[];
};

export type ResearchDiscoveryCheckpoint = {
  state: "pending" | "reserving" | "reserved" | "started" | "completed";
  operationId: string;
  creditsUsed: number | null;
  settled: boolean;
};

/** One bounded search operation returns full page content, never snippets alone. */
export interface ResearchDiscoveryProvider {
  discover(
    input: ResearchDiscoveryInput,
    policy: ResearchPolicy,
    signal: AbortSignal,
  ): Promise<{ sources: ResearchSource[]; creditsUsed: number | null }>;
}

export interface ResearchServiceBudgetPort {
  reserve(input: {
    workspaceId: string;
    budgetId: string;
    operationId: string;
    maximumUnits: number;
  }): Promise<{ status: "created" | "existing-held" | "settled" }>;
  settle(input: { workspaceId: string; operationId: string; actualUnits: number }): Promise<void>;
}

export type ResearchExtractionInput = {
  operationId: string;
  person: {
    id: string;
    revision: number;
    displayName: string;
    description: string;
    professional: ContactFields & { revision: number };
    verifiedAliases?: string[];
  };
  fact: ResearchFactRequest;
  sources: ResearchSource[];
  policy: ResearchPolicy;
};

export interface ResearchExtractionProvider {
  /** Must make one provider request, with automatic provider/SDK retries disabled. */
  extract(
    input: ResearchExtractionInput,
    signal: AbortSignal,
  ): Promise<{
    output: unknown;
    usage: InferenceUsage | null;
  }>;
}

export interface ResearchAdmissionPort {
  /** Atomically claim the exact operation once. An uncertain/replayed claim must
   * refuse another paid submission. The implementation owns the shared ledger. */
  admit(input: ResearchExtractionInput): Promise<void>;
  settle(operationId: string, usage: InferenceUsage): Promise<void>;
}

export type ResearchFactCheckpoint = {
  key: string;
  state: "pending" | "started" | "completed" | "rejected";
  operationId: string;
  finding: ResearchFinding | null;
  usage: InferenceUsage | null;
  settled: boolean;
  failureCode?: ResearchExtractionFailureCode | null;
};

export type ResearchExtractionFailureCode =
  | "invalid_output_schema"
  | "unknown_source"
  | "nonliteral_excerpt"
  | "fact_date_after_retrieval"
  | "fact_date_not_in_source"
  | "identity_name_missing"
  | "identity_context_missing"
  | "supported_evidence_missing"
  | "answer_not_extractive"
  | "unresolved_answer"
  | "conflict_sources_missing"
  | "validation_error";
export type ResearchExecution = {
  workspaceId: string;
  batchId: string;
  actorId: string;
  personId: string;
  generation: number;
  request: ResearchPersonRequest;
  person: ResearchExtractionInput["person"];
  policy: ResearchPolicy;
  status: ResearchStatus;
  sources: ResearchSource[];
  facts: ResearchFactCheckpoint[];
  discovery: ResearchDiscoveryCheckpoint;
  deadline: string;
};
export type ResearchExecutionKey = Pick<
  ResearchExecution,
  "workspaceId" | "batchId" | "personId" | "generation"
>;

export interface ResearchExecutionStore {
  load(key: ResearchExecutionKey): Promise<ResearchExecution | null>;
  /** All writes must fence generation, cancellation, membership, and person revision. */
  start(key: ResearchExecutionKey): Promise<boolean>;
  saveSource(key: ResearchExecutionKey, source: ResearchSource): Promise<boolean>;
  claimDiscovery(key: ResearchExecutionKey): Promise<boolean>;
  markDiscoveryReserved(key: ResearchExecutionKey): Promise<boolean>;
  resetDiscoveryReservation(key: ResearchExecutionKey): Promise<boolean>;
  claimDiscoverySubmission(key: ResearchExecutionKey): Promise<boolean>;
  saveDiscoveredSources(
    key: ResearchExecutionKey,
    sources: ResearchSource[],
    creditsUsed: number | null,
  ): Promise<boolean>;
  markDiscoverySettled(key: ResearchExecutionKey): Promise<void>;
  claimFact(key: ResearchExecutionKey, factKey: string): Promise<boolean>;
  saveFinding(
    key: ResearchExecutionKey,
    factKey: string,
    finding: ResearchFinding,
    usage: InferenceUsage | null,
  ): Promise<boolean>;
  saveRejectedFailure(
    key: ResearchExecutionKey,
    factKey: string,
    failureCode: ResearchExtractionFailureCode,
    usage: InferenceUsage | null,
  ): Promise<boolean>;
  markSettled(key: ResearchExecutionKey, factKey: string): Promise<void>;
  finish(key: ResearchExecutionKey, status: ResearchStatus, error: string | null): Promise<void>;
}
