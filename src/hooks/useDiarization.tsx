import { DiarizationResponse } from './diarization/types';
import { diarize } from './diarization/replicate';
import { useState } from 'react';

export default function useDiarization({ onResult }: { onResult: (result: DiarizationResponse) => void }) {
    const [results, setResults] = useState<DiarizationResponse | null>(null);
    
    const [status, setStatus] = useState<string | null>("idle");

    const runDiarization = async (audio: Blob) => {
        setStatus("diarizing");

        try {
            const transcript = await diarize({audio, num_speakers: 2});

            console.log('Diarization completed:', transcript);
            setResults(transcript);
            onResult(transcript);
            
            setStatus("done");
        } catch (error) {
            console.error('Diarization error:', error);
        } finally {
            setStatus("idle");
        }
    };

    return {
        runDiarization,
        results,
        status
    };
}