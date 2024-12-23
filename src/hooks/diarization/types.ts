export interface DiarizationWord {
    word: string;
    start: number;
    end: number;
    probability: number;
}

export interface DiarizationSegment {
    text: string;
    start: number;
    end: number;
    speaker: string;
    words: DiarizationWord[];
    avg_logprob: number;
}

export interface DiarizationParams {
    audio: Blob;
    num_speakers: number;
}

export interface DiarizationResponse {
    segments: DiarizationSegment[];
    language?: string;
    num_speakers?: number;
} 