import type { Database } from "../repository";
import { createKnowledgeOperations } from "./knowledge";
import { createAssistantProfileRepository } from "./profiles";
import { createPublicationOperations } from "./publications";
import { createRetrievalOperations } from "./retrieval";
import { createTurnOperations } from "./turns";

export function createAssistantRepository(db: Database) {
  return {
    ...createTurnOperations(db),
    ...createKnowledgeOperations(db),
    ...createPublicationOperations(db),
    ...createRetrievalOperations(db),
    ...createAssistantProfileRepository(db),
  };
}

export { createAssistantEvidenceRepository } from "./evidence";
export type { AssistantProfileWriteContext } from "./profiles";
export { createAssistantProfileRepository } from "./profiles";
export type { AssistantArtifactDeletion, AssistantArtifactPublication } from "./publications";
export type {
  AssistantHistoryHit,
  AssistantHistoryRetrieval,
  AssistantHistoryToolHit,
} from "./retrieval";
export type { AssistantWriteContext } from "./shared";
export { readAssistantTranscriptEvidence } from "./transcript-evidence";
export type { AssistantTurnOutput } from "./turns";
export type AssistantRepository = ReturnType<typeof createAssistantRepository>;
