/** Worker-only composition entry point. Server dispatch/status consumers use
 * index.ts and do not need to load the AI SDK or Workers AI provider adapter. */
export type { ResearchEnvironment } from "./runtime";
export { createResearchRuntime, createWorkersResearchExtraction } from "./runtime";
