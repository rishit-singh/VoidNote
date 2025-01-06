import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Loader } from "lucide-react";
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
  const [localAudioBlob, setLocalAudioBlob] = useState<Blob | null>(null);

  const { isListening, startListening, stopListening } = useSpeechRecognition({
    onResult: (result: string) => {
      setTranscriptOutput(result);
      if (noteRef.current) {
        noteRef.current.transcript = result;
        onResult?.(noteRef.current);
      }
    },
  });

  const { isRecording, audioURL, audioBlob, startRecording, stopRecording } =
    useVoiceRecorder();

  const { runDiarization, status: diarizationStatus } = useDiarization({
    onResult: (result) => {
      if (!result?.segments) return;

      const processedResults = result.segments.map((segment: any) => ({
        speaker: segment.speaker,
        text: segment.text,
      }));

      setDiarizationResults(processedResults);
      if (noteRef.current) {
        noteRef.current.diarizationResults = processedResults;
        onResult?.(noteRef.current);
      }
    },
  });

  const fileRef = useRef<HTMLInputElement>(null);

  // Ensure the UI re-renders when the noteRef changes.
  useEffect(() => {
    setTranscriptOutput(""); // Reset transcript for new note
    setDiarizationResults(noteRef.current.diarizationResults || []);
    if (fileRef.current) {
      fileRef.current.value = "";
    }

    stopRecording();
    setLocalAudioBlob(null);
  }, [noteRef.current]);

  useEffect(() => {
    if (audioBlob && audioBlob !== noteRef.current?.audio) {
      setLocalAudioBlob(audioBlob);
      if (noteRef.current) {
        noteRef.current.audio = audioBlob;
      }
    }
  }, [audioBlob]);

  const handleFileUpload = async (file: File) => {
    try {
      await runDiarization(file);
    } catch (err) {
      console.error("Error running diarization:", err);
    }
  };

  const start = async () => {
    try {
      await startListening();
      await startRecording();
    } catch (err) {
      console.error("Error starting recording:", err);
    }
  };

  const stop = async () => {
    try {
      await stopListening();
      await stopRecording();

      if (noteRef.current) {
        noteRef.current.transcript = transcriptOutput.trim();
        noteRef.current.audio = audioBlob;
        noteRef.current.url = audioURL;
        onResult?.(noteRef.current);
      }
    } catch (err) {
      console.error("Error stopping recording:", err);
    }
  };

  return (
    <div className="flex flex-col w-full gap-8 p-6 bg-neutral-900 rounded-lg shadow-lg">
      <div className="text-center mb-4">
        <h2 className="text-2xl font-bold text-white">
          {noteRef.current?.transcript?.trim()
            ? `Editing ${noteRef.current.transcript}`
            : `Editing Note ${noteRef.current?.id?.split("-")[0] || ""}`}
        </h2>
        <p className="text-sm text-gray-400">
          Process your audio files for transcription and diarization.
        </p>
      </div>

      {/* Recording Controls */}
      <div className="flex justify-center gap-4">
        <Button
          onClick={isListening ? stop : start}
          variant={isListening ? "destructive" : "default"}
          size="lg"
          className="px-6 flex items-center gap-2"
        >
          {isListening ? (
            <>
              <Loader className="animate-spin" />
              Stop Recording
            </>
          ) : (
            "Start Recording"
          )}
        </Button>

        {!isRecording && audioURL && (
          <Button asChild variant="secondary" size="lg">
            <a href={audioURL} download="recording.wav">
              Download Audio
            </a>
          </Button>
        )}

        {!isRecording && localAudioBlob && diarizationStatus === "idle" && (
          <Button
            onClick={() => runDiarization(localAudioBlob)}
            variant="secondary"
            size="lg"
            className="px-6"
          >
            Run Diarization
          </Button>
        )}
      </div>

      {/* Transcript Output */}
      {transcriptOutput && (
        <div className="rounded-lg border-2 border-gray-700 bg-gray-800 p-6">
          <p className="text-base text-white leading-relaxed">{transcriptOutput}</p>
        </div>
      )}

      {/* Audio Controls */}
      {!isRecording && audioURL && (
        <div className="rounded-lg border-2 border-gray-700 p-6">
          <audio src={audioURL} controls className="w-full h-12" />
        </div>
      )}

      {/* File Upload Section */}
      {!isRecording && !localAudioBlob && (
        <div className="flex flex-col items-center gap-4">
          <div className="relative text-sm uppercase">
            <span className="bg-neutral-900 px-3 py-1 text-gray-400">or upload</span>
          </div>
          <label
            htmlFor="audioUpload"
            className="flex flex-col items-center justify-center border-2 border-dotted border-white rounded-lg p-10 w-full max-w-md cursor-pointer hover:border-white transition-colors"
          >
            <span className="text-white mb-2">Drag & Drop or Click to Upload</span>
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
      )}

      {/* Diarization Status */}
      {diarizationStatus === "diarizing" && (
        <div className="flex items-center gap-3 text-gray-400">
          <Loader className="animate-spin" />
          <span>Processing audio...</span>
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
