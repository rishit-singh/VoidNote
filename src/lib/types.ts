export interface NoteModel {
  id: string;
  title: string;
  transcript: string;
  createdAt: string | null;
  updatedAt: string | null;
  audio: Blob | null;
  url: string | null;
  recordingSessionId: string | null;
  workspaceId?: string;
  revision?: number;
  deletedAt?: string | null;
  scopeEpoch?: number;
}

export interface RecordingSessionMeta {
  id: string;
  noteId: string;
  userId?: string | undefined;
  workspaceId?: string | undefined;
  status: "recording" | "recoverable" | "finalized";
  mimeType: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecordingChunkRecord {
  id: string;
  sessionId: string;
  sequence: number;
  blob: Blob;
  createdAt: string;
}

export const createNoteModel = (overrides: Partial<NoteModel> = {}): NoteModel => {
  const now = new Date().toISOString();

  return {
    id: globalThis.crypto?.randomUUID?.() ?? `note-${Date.now()}`,
    title: "",
    transcript: "",
    createdAt: now,
    updatedAt: now,
    audio: null,
    url: null,
    recordingSessionId: null,
    ...overrides,
  };
};
