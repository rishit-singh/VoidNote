import { useState, useRef } from "react";

export const useSpeechRecognition = ({ onResult }: { onResult: (transcript: string) => void | undefined }) => {
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState("");
    const [error, setError] = useState(null);
    const [finalTranscript, setFinalTranscript] = useState("");

    const speechRecognitionRef = useRef<any>(null);

    if (!speechRecognitionRef.current) {
        speechRecognitionRef.current = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        speechRecognitionRef.current.lang = 'en-US';
        speechRecognitionRef.current.continuous = true;
        speechRecognitionRef.current.interimResults = true;
        speechRecognitionRef.current.maxAlternatives = 1;

        speechRecognitionRef.current.onresult = (event: any) => {
            const results = Array.from(event.results);
            let interimTranscript = '';
            
            results.forEach((result: any) => {
                if (result.isFinal) {
                    setFinalTranscript(prev => prev + ' ' + result[0].transcript);
                } else {
                    interimTranscript += result[0].transcript;
                }
            });

            const fullTranscript = (finalTranscript + ' ' + interimTranscript).trim();
            setTranscript(fullTranscript);
            onResult(fullTranscript);
        };

        speechRecognitionRef.current.onerror = (event: any) => {
            setError(event.error);
        };
    }

    const startListening = () => {
        setFinalTranscript('');
        setTranscript('');
        speechRecognitionRef.current.start();
        setIsListening(true);
    };

    const stopListening = () => {
        if (speechRecognitionRef.current) {
            speechRecognitionRef.current.stop();
            setIsListening(false);
        }
    };

    return { isListening, transcript, error, startListening, stopListening };
}