import { useCallback, useEffect, useState } from "react";

export const useSpeechRecognition = ({ onResult }: { onResult: (transcript: string) => void }) => {
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState("");
    const [error, setError] = useState<string | null>(null);

    const recognition = useCallback(() => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            throw new Error("Speech recognition not supported");
        }
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        return recognition;
    }, []);

    const startListening = useCallback(() => {
        try {
            const recognitionInstance = recognition();
            
            recognitionInstance.onresult = (event) => {
                const transcript = Array.from(event.results)
                    .map(result => result[0].transcript)
                    .join(" ");
                
                setTranscript(transcript);
                onResult(transcript);
            };

            recognitionInstance.onerror = (event) => {
                setError(event.error);
                setIsListening(false);
            };

            recognitionInstance.start();
            setIsListening(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error occurred");
        }
    }, [recognition, onResult]);

    const stopListening = useCallback(() => {
        try {
            const recognitionInstance = recognition();
            recognitionInstance.stop();
            setIsListening(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error occurred");
        }
    }, [recognition]);

    useEffect(() => {
        return () => {
            if (isListening) {
                stopListening();
            }
        };
    }, [isListening, stopListening]);

    return { isListening, transcript, error, startListening, stopListening };
};
