import { DiarizationParams, DiarizationResponse } from './types';

const toBase64String = (audio: Blob) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(audio);
    });
}
export const diarize = async ({audio, num_speakers}: DiarizationParams): Promise<DiarizationResponse> => {
    const base64Audio = await toBase64String(audio);
    
    const response = await fetch('http://localhost:3000/api/diarize', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            file_string: base64Audio,
            num_speakers,
            language: "en"
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Diarization failed: ${response.status} ${response.statusText}. ${error}`);
    }

    return await response.json();
};

