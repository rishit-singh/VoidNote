import { Download, Loader, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import Results from "@/components/Results";
import useDiarization from "@/hooks/useDiarization";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";

export interface Audio {
    blob: Blob | null;
    url: string | null;
}

export interface NoteModel {
    id: string;
    transcript: string;
    diarizationResults: any[];
    createdAt: Date | null;
    audio: Blob | null;
    url: string | null;
}

export function Note({
  noteRef,
  onResult,
}: {
  noteRef: React.MutableRefObject<NoteModel>;
  onResult?: (note: NoteModel) => void;
}) {
  const [transcriptOutput, setTranscriptOutput] = useState<string>("");
  const [diarizationResults, setDiarizationResults] = useState<any[]>([]);

  const { isListening, startListening, stopListening } = useSpeechRecognition({
    onResult: (result: string) => {
      setTranscriptOutput(result);
      noteRef.current.transcript = result;
      onResult?.(noteRef.current);
    },
  });

  const { isRecording, audioURL} =
    useVoiceRecorder();

  const { runDiarization, status: diarizationStatus } = useDiarization({
    onResult: (result) => {
      const processedResults = result.segments.map((segment: any) => ({
        speaker: segment.speaker,
        text: segment.text,
      }));
      setDiarizationResults(processedResults);
      noteRef.current.diarizationResults = processedResults;
      onResult?.(noteRef.current);
    },
  });

  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (file: File) => {
    await runDiarization(file);
  };

  return (
    <div className="flex flex-col w-full gap-8 p-6 bg-muted/10 rounded-lg shadow-lg">
      <div className="text-center mb-4">
        <h2 className="text-2xl font-bold text-foreground">
          Upload or Record Audio
        </h2>
        <p className="text-sm text-muted-foreground">
          Process your audio files for transcription and diarization.
        </p>
      </div>

      {/* Recording Controls */}
      <div className="flex justify-center gap-4">
        <Button
          onClick={isListening ? stopListening : startListening}
          variant={isListening ? "destructive" : "default"}
          size="lg"
        >
          {isListening ? (
            <>
              <Loader className="animate-spin mr-2" />
              Stop Recording
            </>
          ) : (
            <>
              <Upload className="mr-2" />
              Start Recording
            </>
          )}
        </Button>

        {!isRecording && audioURL && (
          <Button asChild variant="secondary" size="lg">
            <a href={audioURL} download="recording.wav">
              <Download className="mr-2" />
              Download Audio
            </a>
          </Button>
        )}
      </div>

      {/* File Upload Section */}
      <div className="flex flex-col items-center gap-4">
        <div className="relative text-sm uppercase">
          <span className="bg-muted px-3 py-1 text-muted-foreground">
            or upload
          </span>
        </div>
        <label
          htmlFor="audioUpload"
          className="flex flex-col items-center justify-center border-2 border-dashed border-input rounded-lg p-6 w-full max-w-md cursor-pointer hover:border-accent/50 transition-colors"
        >
          <Upload className="text-muted-foreground w-8 h-8 mb-2" />
          <span className="text-sm text-muted-foreground">
            Drag & Drop or Click to Upload
          </span>
          <input
            id="audioUpload"
            type="file"
            accept="audio/*"
            ref={fileRef}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileUpload(file);
            }}
          />
        </label>
      </div>

      {/* Diarization Status */}
      {diarizationStatus === "diarizing" && (
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader className="animate-spin w-5 h-5" />
          <span>Processing audio...</span>
        </div>
      )}

      {/* Transcript Output */}
      {transcriptOutput && (
        <div className="bg-muted/20 rounded-lg p-6 border border-border">
          <p className="text-base text-foreground leading-relaxed">
            {transcriptOutput}
          </p>
        </div>
      )}

      {/* Diarization Results */}
      {!isRecording && diarizationResults.length > 0 && (
        <Results
          results={diarizationResults}
          id={noteRef.current?.id || ""}
          note={noteRef.current}
          onUpdate={onResult}
        />
      )}
    </div>
  );
}
