import React, { useEffect, useRef, useState } from "react";

import { AudioRecorder } from "./audioRecorder/AudioRecorder";
import { FileUploader } from "./FileUploader/FileUploader";
import { Loader } from "lucide-react";
import { NoteModel } from "@/types/types";
import Results from "./Results";
import useDiarization from "@/hooks/useDiarization";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";

interface NoteProps {
  noteRef: React.MutableRefObject<NoteModel>;
  onResult?: (note: NoteModel) => void;
}

export function Note({ noteRef, onResult }: NoteProps) {
  const [transcriptOutput, setTranscriptOutput] = useState<string>("");
  const [diarizationResults, setDiarizationResults] = useState<any[]>([]);
  const [localAudioBlob, setLocalAudioBlob] = useState<Blob | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Speech recognition setup
  const { isListening, startListening, stopListening } = useSpeechRecognition({
    onResult: (result: string) => {
      setTranscriptOutput(result);
      if (noteRef.current) {
        noteRef.current.transcript = result;
        onResult?.(noteRef.current);
      }
    },
  });

  // Voice recorder setup
  const { isRecording, audioURL, audioBlob, startRecording, stopRecording } =
    useVoiceRecorder();

  // Diarization setup
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

  // Reset state when noteRef changes
  useEffect(() => {
    setTranscriptOutput("");
    setDiarizationResults(noteRef.current.diarizationResults || []);
    if (fileRef.current) {
      fileRef.current.value = "";
    }
    stopRecording();
    setLocalAudioBlob(null);
  }, [noteRef.current]);

  // Update audio blob when it changes
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

  const handleStart = async () => {
    try {
      await startListening();
      await startRecording();
    } catch (err) {
      console.error("Error starting recording:", err);
    }
  };

  const handleStop = async () => {
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

  const handleDiarize = async () => {
    if (localAudioBlob) {
      await runDiarization(localAudioBlob);
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

      <AudioRecorder
        isListening={isListening}
        isRecording={isRecording}
        audioURL={audioURL}
        onStart={handleStart}
        onStop={handleStop}
        onDiarize={handleDiarize}
        diarizationStatus={diarizationStatus as "idle" | "diarizing" | "error"}
        localAudioBlob={localAudioBlob}
      />

      {transcriptOutput && (
        <div className="rounded-lg border-2 border-gray-700 bg-gray-800 p-6">
          <p className="text-base text-white leading-relaxed">
            {transcriptOutput}
          </p>
        </div>
      )}

      <FileUploader
      onFileUpload={handleFileUpload}
      isRecording={isRecording}
      localAudioBlob={localAudioBlob}
      fileRef={fileRef}
      />

      {diarizationStatus === "diarizing" && (
        <div className="flex items-center gap-3 text-gray-400">
          <Loader className="animate-spin" />
          <span>Processing audio...</span>
        </div>
      )}

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
