"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { speechRecognitionSupported } from "@/hooks/useSpeechRecognition";
import {
  defaultRecordingPreferences,
  recordingPreferenceKey,
  useRecordingPreferences,
} from "@/stores/use-recording-preferences";
import { useCaptureStore } from "@/stores/use-capture-store";
import { useNoteStore } from "@/stores/use-note-store";

const subscribeSupport = () => () => {};
export function RecordingSettings() {
  useNoteStore((state) => state.epoch);
  const preferences = useRecordingPreferences((state) => state.byOwner);
  const update = useRecordingPreferences((state) => state.update);
  const reset = useRecordingPreferences((state) => state.reset);
  const persistenceStatus = useRecordingPreferences((state) => state.persistenceStatus);
  const persistenceError = useRecordingPreferences((state) => state.persistenceError);
  const hasSavedPreferences = Boolean(preferences[recordingPreferenceKey()]);
  const settings = preferences[recordingPreferenceKey()] ?? defaultRecordingPreferences;
  const status = useCaptureStore((state) => state.status);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const speechSupported = useSyncExternalStore(
    subscribeSupport,
    speechRecognitionSupported,
    () => false,
  );
  const busy = !["idle", "error"].includes(status);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      if (navigator.mediaDevices?.enumerateDevices) {
        setDeviceError(null);
        void navigator.mediaDevices
          .enumerateDevices()
          .then((devices) => {
            if (!disposed)
              setDevices(
                devices.filter(
                  (device) =>
                    device.kind === "audioinput" &&
                    device.deviceId &&
                    device.deviceId !== "default",
                ),
              );
          })
          .catch(() => {
            if (!disposed) setDeviceError("Microphone list is unavailable.");
          });
      }
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      disposed = true;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, []);
  return (
    <FieldGroup>
      <p role="status" aria-live="polite">
        {persistenceStatus === "hydrating"
          ? "Loading saved recording preferences…"
          : persistenceStatus === "error"
            ? (persistenceError ?? "Recording preferences could not be saved.")
            : persistenceStatus === "invalid"
              ? (persistenceError ?? "Saved preferences were invalid and have been reset.")
              : hasSavedPreferences
                ? "Recording preferences saved on this device."
                : "Using browser defaults; changes are saved on this device."}
      </p>
      <Field data-disabled={busy}>
        <FieldLabel htmlFor="recording-microphone">Microphone</FieldLabel>
        <Select
          value={settings.deviceId}
          onValueChange={(deviceId) => {
            update({ deviceId });
          }}
          disabled={busy}
        >
          <SelectTrigger id="recording-microphone">
            <SelectValue placeholder="Default microphone" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="default">Default microphone</SelectItem>
              {settings.deviceId !== "default" &&
                !devices.some((device) => device.deviceId === settings.deviceId) && (
                  <SelectItem value={settings.deviceId} disabled>
                    Saved microphone unavailable
                  </SelectItem>
                )}
              {devices.map((device, index) => (
                <SelectItem key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          {deviceError ||
            "Microphone names become available after permission is granted. Selection applies to the next recording."}
        </FieldDescription>
        {settings.deviceId !== "default" &&
          !devices.some((device) => device.deviceId === settings.deviceId) && (
            <Button
              variant="outline"
              className="self-start"
              onClick={() => {
                update({ deviceId: "default" });
              }}
            >
              Use default microphone
            </Button>
          )}
      </Field>
      <Field orientation="horizontal" data-disabled={!speechSupported}>
        <FieldContent>
          <FieldLabel htmlFor="recording-live-text">Browser live text</FieldLabel>
          <FieldDescription>
            {speechSupported
              ? "Optional browser speech recognition; may use your browser’s online service. Audio recording does not depend on it."
              : "Unsupported in this browser. Audio recording still works."}
          </FieldDescription>
        </FieldContent>
        <Switch
          id="recording-live-text"
          checked={settings.liveText}
          disabled={!speechSupported}
          onCheckedChange={(liveText) => {
            update({ liveText });
          }}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="recording-waveform">Microphone waveform</FieldLabel>
          <FieldDescription>
            Show the actual microphone signal while recording on wider screens.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="recording-waveform"
          checked={settings.waveform}
          onCheckedChange={(waveform) => {
            update({ waveform });
          }}
        />
      </Field>
      <Button
        variant="ghost"
        className="self-start"
        onClick={() => {
          reset();
        }}
      >
        Reset recording preferences
      </Button>
    </FieldGroup>
  );
}
