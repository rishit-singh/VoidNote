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
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Reset state when note changes
    if (noteRef.current) {
      setTranscriptOutput(noteRef.current.transcript || "");
      setDiarizationResults(noteRef.current.diarizationResults || []);
      setLocalAudioBlob(noteRef.current.audio);
      setAudioUrl(noteRef.current.url);
    }
  }, [noteRef.current.id]);

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
  const { isRecording, audioBlob, startRecording, stopRecording } = useVoiceRecorder();

  useEffect(() => {
    if (audioBlob) {
      const url = URL.createObjectURL(audioBlob);
      setLocalAudioBlob(audioBlob);
      setAudioUrl(url);
      if (noteRef.current) {
        noteRef.current.audio = audioBlob;
        noteRef.current.url = url;
        onResult?.(noteRef.current);
      }
    }
  }, [audioBlob]);

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

  const handleDiarization = async () => {
    if (!localAudioBlob) return;
    await runDiarization(localAudioBlob);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4">
        <AudioRecorder
          isListening={isListening}
          isRecording={isRecording}
          audioURL={audioUrl}
          onStart={startRecording}
          onStop={stopRecording}
          onDiarize={handleDiarization}
          diarizationStatus={diarizationStatus}
          localAudioBlob={localAudioBlob}
          noteId={noteRef.current.id}
        />
      </div>

      {diarizationResults.length > 0 ? (
        <Results 
          results={diarizationResults} 
          id={noteRef.current.id}
          note={noteRef.current}
          onUpdate={onResult}
        />
      ) : (
        <div className="min-h-[200px] rounded-lg border-2 border-dashed border-neutral-800 p-4">
          <p className="text-center text-neutral-500">
            {isListening ? "Listening..." : "Start recording or run diarization to see results"}
          </p>
        </div>
      )}
    </div>
  );
}
