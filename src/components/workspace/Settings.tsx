"use client";

import { ExclamationTriangleIcon, SpeakerLoudIcon } from "@radix-ui/react-icons";
import { useNoteStore } from "@/stores/use-note-store";
import { RecordingSettings } from "@/components/recording";
import { Button } from "@/components/ui/button";
import { AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function Settings() {
  const session = useNoteStore((state) => state.session);
  const recoveryError = useNoteStore((state) => state.recoveryError);
  return (
    <section className="vn-page vn-settings" aria-labelledby="settings-title">
      <div className="vn-page-heading">
        <h1 id="settings-title">Settings</h1>
      </div>
      <div className="vn-settings-content">
        <section className="vn-settings-section" aria-labelledby="recording-settings-title">
          <div className="vn-settings-section-heading">
            <SpeakerLoudIcon aria-hidden="true" />
            <div>
              <h2 id="recording-settings-title">Recording</h2>
              <p>Controls that are available in this workspace.</p>
            </div>
          </div>
          <RecordingSettings />
        </section>
        <section className="vn-settings-section" aria-labelledby="privacy-title">
          <h2 id="privacy-title">Transcription and privacy</h2>
          <p className="vn-settings-copy">
            Browser live text uses the speech recognition service provided by your browser and may
            be processed online. Microphone audio is saved locally first. Upload & transcribe on a
            note saves a private remote copy and sends that audio to pyannoteAI for finalized
            processing.
          </p>
          <div className="vn-capability-note">
            <ExclamationTriangleIcon aria-hidden="true" />
            <p>
              Browser live text and finalized transcription have independent lifecycles. Voice
              matching and provider selection are not available yet.
            </p>
          </div>
        </section>
        <section className="vn-settings-section" aria-labelledby="account-title">
          <h2 id="account-title">Account</h2>
          <dl className="vn-account-row">
            <dt>Signed in as</dt>
            <dd>{session?.user.email ?? "—"}</dd>
          </dl>
          <p className="vn-settings-copy">
            Unsaved changes are kept in browser storage on this device for recovery when possible.
            Clearing browser data removes that recovery copy.
          </p>
          {recoveryError && (
            <Alert variant="destructive">
              <AlertDescription>{recoveryError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogTrigger asChild>
            <Button className="self-start" variant="outline">
              Sign out
            </Button>
          </AlertDialogTrigger>
        </section>
      </div>
    </section>
  );
}

export default Settings;
