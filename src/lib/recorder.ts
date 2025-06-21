interface Recorder {
    isRecording: boolean;
    audioBlob: Blob | null;
    audioURL: string | null;

    stream: MediaStream | null;

    startRecording(): Promise<void>;
    stopRecording(): void;
    onStreamInput(event: BlobEvent): void;
    assertClosed(): Promise<boolean> 
} 

export type { Recorder };