"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type SpeechStatus =
  "off" | "starting" | "listening" | "disconnected" | "unsupported" | "error";

export const speechRecognitionSupported = () =>
  typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

export function useSpeechRecognition({
  onResult,
  ownerKey = "default",
}: {
  onResult: (text: string) => void;
  ownerKey?: string;
}) {
  const callback = useRef(onResult);
  const currentOwner = useRef(ownerKey);
  const recognition = useRef<SpeechRecognition | null>(null);
  const generation = useRef(0);
  const failedRun = useRef<number | null>(null);
  const [status, setStatus] = useState<SpeechStatus>("off");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    callback.current = onResult;
  }, [onResult]);
  useLayoutEffect(() => {
    if (currentOwner.current === ownerKey) return;
    currentOwner.current = ownerKey;
    generation.current += 1;
    const active = recognition.current;
    recognition.current = null;
    if (active) {
      active.onend = () => {};
      active.onresult = () => {};
      active.onerror = () => {};
      try {
        active.abort();
      } catch {
        /* already stopped */
      }
    }
    setStatus("off");
    setError(null);
  }, [ownerKey]);

  const stopListening = useCallback(() => {
    generation.current += 1;
    const active = recognition.current;
    recognition.current = null;
    if (active) {
      active.onend = () => {};
      active.onresult = () => {};
      active.onerror = () => {};
      try {
        active.abort();
      } catch {
        /* already stopped */
      }
    }
    setStatus("off");
    setError(null);
  }, []);

  const startListening = useCallback(() => {
    if (recognition.current) return;
    const Constructor =
      typeof window === "undefined"
        ? undefined
        : window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Constructor) {
      setStatus("unsupported");
      setError("Browser live text is unsupported. Audio recording still works.");
      return;
    }
    const instance = new Constructor();
    const ownerAtStart = ownerKey;
    const run = ++generation.current;
    failedRun.current = null;
    recognition.current = instance;
    setStatus("starting");
    setError(null);
    instance.continuous = true;
    instance.interimResults = false;
    const isCurrent = () =>
      recognition.current === instance &&
      generation.current === run &&
      currentOwner.current === ownerAtStart;
    instance.onstart = () => {
      if (isCurrent()) setStatus("listening");
    };
    instance.onend = () => {
      if (!isCurrent()) return;
      recognition.current = null;
      if (failedRun.current !== run) {
        setStatus("disconnected");
        setError(
          "Browser live text disconnected. Audio recording continues; retry live text when ready.",
        );
      }
    };
    instance.onerror = (event) => {
      if (!isCurrent()) return;
      failedRun.current = run;
      recognition.current = null;
      setStatus("error");
      setError(`Browser live text: ${event.error}. Audio recording continues.`);
      try {
        instance.abort();
      } catch {
        /* already stopped */
      }
    };
    instance.onresult = (event) => {
      if (!isCurrent()) return;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal && result[0]?.transcript.trim())
          callback.current(result[0].transcript.trim());
      }
    };
    try {
      instance.start();
    } catch {
      if (isCurrent()) {
        recognition.current = null;
        setStatus("error");
        setError("Browser live text could not start. Audio recording continues.");
      }
    }
  }, [ownerKey]);

  const retryListening = useCallback(() => {
    if (status === "unsupported" || status === "starting" || status === "listening") return;
    setStatus("off");
    startListening();
  }, [startListening, status]);

  useEffect(
    () => () => {
      generation.current += 1;
      const active = recognition.current;
      recognition.current = null;
      if (active) {
        active.onend = () => {};
        active.onresult = () => {};
        active.onerror = () => {};
        try {
          active.abort();
        } catch {
          /* already stopped */
        }
      }
    },
    [],
  );

  return {
    status,
    error,
    isListening: status === "listening",
    startListening,
    retryListening,
    stopListening,
  };
}
