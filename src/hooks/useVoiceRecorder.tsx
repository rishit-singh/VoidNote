// hooks/useVoiceRecorder.ts
import { useEffect, useRef, useState } from "react";

export const useVoiceRecorder = () => {
    const [isRecording, setIsRecording] = useState(false);
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [audioURL, setAudioURL] = useState<string | null>(null);
    
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            mediaRecorderRef.current = new MediaRecorder(stream);
            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    setAudioBlob(event.data);
                }
            };
            setIsRecording(true);
            mediaRecorderRef.current.start();
        } catch (error) {
            console.error("Error starting recording:", error);
        }
    }

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            setIsRecording(false);
            mediaRecorderRef.current.stop();
            // Stop all tracks in the stream
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }
        }
    }

    const resetRecording = () => {
        if (audioURL) {
            URL.revokeObjectURL(audioURL);
        }
        setAudioBlob(null);
        setAudioURL(null);
        setIsRecording(false);
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
    }

    useEffect(() => {
        if (audioBlob) {
            const url = URL.createObjectURL(audioBlob);
            setAudioURL(url);
        }

        // Cleanup function
        return () => {
            if (audioURL) {
                URL.revokeObjectURL(audioURL);
            }
        };
    }, [audioBlob]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (audioURL) {
                URL.revokeObjectURL(audioURL);
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
            }
        };
    }, []);

    return { 
        isRecording, 
        audioURL, 
        audioBlob, 
        startRecording, 
        stopRecording,
        resetRecording 
    };
}