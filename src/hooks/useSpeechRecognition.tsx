import { useRef, useState } from "react";

export const useSpeechRecognition = ({ onResult }: { onResult: (transcript: string) => void }) => {
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState("");
    const [error, setError] = useState<string | null>(null);

    const speechRecognitionRef = useRef<any>(null);
    const finalTranscriptRef = useRef<string>("");

    if (!speechRecognitionRef.current) {
        // Initialize SpeechRecognition instance
        speechRecognitionRef.current = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        speechRecognitionRef.current.lang = 'en-US';
        speechRecognitionRef.current.continuous = true;
        speechRecognitionRef.current.interimResults = true;
        speechRecognitionRef.current.maxAlternatives = 1;

        speechRecognitionRef.current.onresult = (event: any) => {
            const results = Array.from(event.results);
            let interimTranscript = "";

            results.forEach((result: any) => {
                if (result.isFinal) {
                    finalTranscriptRef.current += result[0].transcript + " ";
                } else {
                    interimTranscript += result[0].transcript;
                }
            });

            const fullTranscript = (finalTranscriptRef.current + interimTranscript).trim();
            setTranscript(fullTranscript);
            onResult(fullTranscript);
        };

        speechRecognitionRef.current.onerror = (event: any) => {
            setError(event.error);
        };
    }

    const startListening = () => {
        finalTranscriptRef.current = ""; // Reset the ref
        setTranscript(""); // Clear the UI transcript
        speechRecognitionRef.current.start();
        setIsListening(true);
    };

    const stopListening = () => {
        speechRecognitionRef.current.stop();
        setIsListening(false);
    };

    return { isListening, transcript, error, startListening, stopListening };
};
