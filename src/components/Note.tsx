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

  // Speech recognition setup
  const { isListening, startListening, stopListening } = useSpeechRecognition({
    onResult: (result: string) => {
      console.log("Speech recognition result:", result); // Debugging log
      setTranscriptOutput(result);
      if (noteRef.current) {
        noteRef.current.transcript = result;
        console.log("Updated noteRef:", noteRef.current); // Debugging log
        onResult?.(noteRef.current);
      }
    },
  });
  

  // Voice recorder setup
  const { isRecording, audioBlob, startRecording, stopRecording } =
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
  useEffect(() => {
    const loadNoteData = () => {
      if (!noteRef.current) {
        console.warn("noteRef.current is not initialized");
        return;
      }
    
      console.log("Loading note data:", noteRef.current); // Debugging log
    
      setTranscriptOutput(noteRef.current.transcript || "");
      setDiarizationResults(noteRef.current.diarizationResults || []);
    
      if (noteRef.current.audio instanceof Blob) {
        const newUrl = URL.createObjectURL(noteRef.current.audio);
        setLocalAudioBlob(noteRef.current.audio);
        setAudioUrl(newUrl);
      } else {
        console.warn("Invalid audio blob:", noteRef.current.audio); // Debugging log
        setLocalAudioBlob(null);
        setAudioUrl(null);
      }
    
      if (fileRef.current) {
        fileRef.current.value = "";
      }
    
      stopRecording();
    };
    
  
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
    }
  
    loadNoteData();
  }, [noteRef, noteRef.current?.id]);
  
  // Update audio state when recording changes
  useEffect(() => {
    if (audioBlob) {
      const newUrl = URL.createObjectURL(audioBlob);
      setLocalAudioBlob(audioBlob);
      setAudioUrl(newUrl);

      if (noteRef.current) {
        noteRef.current.audio = audioBlob;
        noteRef.current.url = newUrl;
        onResult?.(noteRef.current);
      }
    }
  }, [audioBlob]);

  // Cleanup function for audio resources
  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, []);

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

      if (noteRef.current && audioBlob) {
        const newUrl = URL.createObjectURL(audioBlob);
        setAudioUrl(newUrl);

        noteRef.current.transcript = transcriptOutput.trim();
        noteRef.current.audio = audioBlob;
        noteRef.current.url = newUrl;
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
        audioURL={audioUrl} 
        onStart={handleStart}
        onStop={handleStop}
        onDiarize={handleDiarize}
        diarizationStatus={diarizationStatus}
        localAudioBlob={localAudioBlob}
        noteId={noteRef.current.id}
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
