export interface Audio {
  blob: Blob | null;
  url: string | null;
}

export interface NoteModel {
  id: string;
  transcript: string;
  diarizationResults: Array<{
    speaker: string;
    text: string;
  }>;
  createdAt: Date | null;
  audio: Blob | null;
  url: string | null;
}

export interface DiarizationResult {
  speaker: string;
  text: string;
}
