import { AssemblyAI, TranscribeParams } from "assemblyai";

export const assemblyAI = new AssemblyAI({
    apiKey: import.meta.env.VITE_ASSEMBLYAI_API_KEY
});

export const transcribe = async (audio: Blob, speakerLabels: boolean = false) => {
    const params: TranscribeParams = {  
        audio: new File([audio], 'audio.wav', { type: audio.type }),
        speaker_labels: speakerLabels
    };

    return await assemblyAI.transcripts.transcribe(params);
}