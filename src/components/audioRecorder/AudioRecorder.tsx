import { Button } from '@/components/ui/button';
import { Loader } from 'lucide-react';

interface AudioRecorderProps {
  isListening: boolean;
  isRecording: boolean;
  audioURL: string | null;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onDiarize: () => Promise<void>;
  diarizationStatus: string;
  localAudioBlob: Blob | null;
}

export const AudioRecorder: React.FC<AudioRecorderProps> = ({
  isListening,
  isRecording,
  audioURL,
  onStart,
  onStop,
  onDiarize,
  diarizationStatus,
  localAudioBlob,
}) => {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-center gap-4">
        <Button
          onClick={isListening ? onStop : onStart}
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
            onClick={onDiarize}
            variant="secondary"
            size="lg"
            className="px-6"
          >
            Run Diarization
          </Button>
        )}
      </div>

      {!isRecording && audioURL && (
        <div className="rounded-lg border-2 border-gray-700 p-6">
          <audio src={audioURL} controls className="w-full h-12" />
        </div>
      )}
    </div>
  );
};
