"use client";
import { useCaptureStore } from "@/stores/use-capture-store";

// A view over the persistent capture service, not an editor-owned MediaRecorder.
export const useVoiceRecorder = () => useCaptureStore();
export default useVoiceRecorder;
