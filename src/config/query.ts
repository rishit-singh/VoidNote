/** Browser read policy. These are build-time defaults, never persisted remote records. */
export const queryPolicy = {
  staleTimeMs: 30_000,
  garbageCollectionTimeMs: 5 * 60_000,
  readRetryCount: 1,
  notesPageSize: 30,
  peoplePageSize: 30,
  titleAutosaveDelayMs: 600,
} as const;
