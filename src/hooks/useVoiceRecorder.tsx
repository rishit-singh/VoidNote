import { useEffect, useState, useRef } from "react";
import { Recorder } from "@/lib/recorder";
import logger from "@/lib/logger";

type BrowserMediaRecorder = {   
    RecorderState: Recorder,
    MediaRecorder: MediaRecorder
}

const createBrowserMediaRecorder = async (onStreamInput: (event: BlobEvent) => void): Promise<BrowserMediaRecorder> => {
    let isRecording = false;
    let audioBlob: Blob | null = null;
    let audioURL: string | null = null;
    let stream: MediaStream | null = null;

    let mediaRecorder: MediaRecorder | null;

    const tracks = useRef<MediaStreamTrack[]>([]);

    const setupMediaRecorder = (stream: MediaStream): MediaRecorder => {
        const newMediaRecorder = new MediaRecorder(stream);

        newMediaRecorder.ondataavailable = (event: BlobEvent) => {
            if (!event.data) return;

            if (event.data.size > 0) {
                onStreamInput(event);
            }
        };

        newMediaRecorder.onstop = () => {
            cleanUpStream()

            isRecording = false;
            audioBlob = null;
            audioURL = null;
        };

        return newMediaRecorder;
    }

    const createStream = async (): Promise<MediaStream> => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        tracks.current = stream.getTracks();

        return stream;
    }

    const startRecording = async (): Promise<void> => {
        mediaRecorder?.start();
    }

    const stopRecording = (): void => {
        mediaRecorder?.stop();
    }

    const cleanUpStream = (): void => {
        if (tracks.current.length > 0) {
            tracks.current.forEach(track => track.stop());
            tracks.current = [];
            stream = null;
        }
    }

    const assertClosed = async (): Promise<boolean> => {
        if (tracks.current) {
            if (tracks.current.length === 0) return true;

            return tracks.current.every(track => track.readyState === "ended");
        }

        return false;
    }

    const newStream = await createStream();

    if (!newStream) {
        throw new Error("Create stream failed.");
    }

    mediaRecorder = setupMediaRecorder(newStream);
    
    return {
        RecorderState: {
            isRecording,
            audioBlob,
            audioURL,
            stream,
            startRecording,
            stopRecording,
            onStreamInput,
            assertClosed,
        },

        MediaRecorder: mediaRecorder as MediaRecorder
    };
}

export const useVoiceRecorder = (): BrowserMediaRecorder => {
    const recorder = useRef<BrowserMediaRecorder | null>(null);
    const [recorderState, setRecorderState] = useState<BrowserMediaRecorder | null>(null);

    useEffect(() => {
        createBrowserMediaRecorder((event: BlobEvent) => {
            setRecorderState(recorder => {
                if (!recorder) return null;

                recorder.RecorderState.audioBlob = event.data as Blob;
                recorder.RecorderState.audioURL = URL.createObjectURL(event.data as Blob);
                return recorder;
            });
        }).then(r => recorder.current = r);
    }, []);
    
    
    return {
        RecorderState: recorderState?.RecorderState as Recorder,
        MediaRecorder: recorderState?.MediaRecorder as MediaRecorder,
    };
}


export default useVoiceRecorder;