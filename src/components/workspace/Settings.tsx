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
    <section
      className="mx-auto flex w-full max-w-[960px] flex-[1_0_auto] flex-col gap-section px-[clamp(24px,5.5vw,80px)] pb-10 pt-14 [@media(max-width:760px)]:gap-[22px] [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pb-8 [@media(max-width:760px)]:pt-[30px]"
      aria-labelledby="settings-title"
    >
      <div className="flex min-h-11 items-center justify-between gap-4">
        <h1
          id="settings-title"
          className="m-0 text-title text-vn-text [@media(max-width:760px)]:text-[24px]"
        >
          Settings
        </h1>
      </div>
      <div className="flex max-w-[800px] flex-col gap-[26px]">
        <section
          className="flex flex-col gap-4 border-b border-vn-stroke pb-6"
          aria-labelledby="recording-settings-title"
        >
          <div className="flex items-start gap-3">
            <SpeakerLoudIcon className="size-[17px] text-vn-muted" aria-hidden="true" />
            <div>
              <h2
                id="recording-settings-title"
                className="m-0 text-[15px] font-medium text-vn-text"
              >
                Recording
              </h2>
              <p className="mb-0 mt-[5px] leading-[1.7] text-vn-muted">
                Controls that are available in this workspace.
              </p>
            </div>
          </div>
          <RecordingSettings />
        </section>
        <section
          className="flex flex-col gap-4 border-b border-vn-stroke pb-6"
          aria-labelledby="privacy-title"
        >
          <h2 id="privacy-title" className="m-0 text-[15px] font-medium text-vn-text">
            Transcription and privacy
          </h2>
          <p className="mb-0 mt-[5px] leading-[1.7] text-vn-muted">
            Browser live text uses the speech recognition service provided by your browser and may
            be processed online. Microphone audio is saved locally first. Upload & transcribe on a
            note saves a private remote copy and sends that audio to pyannoteAI for finalized
            processing.
          </p>
          <div className="flex max-w-[700px] items-start gap-2.5 border border-vn-stroke-strong px-3.5 py-3 text-vn-secondary">
            <ExclamationTriangleIcon
              className="size-4 flex-none text-vn-muted"
              aria-hidden="true"
            />
            <p className="m-0 leading-[1.7] text-vn-muted">
              Browser live text and finalized transcription have independent lifecycles. Voice
              matching and provider selection are not available yet.
            </p>
          </div>
        </section>
        <section
          className="flex flex-col gap-4 border-b border-vn-stroke pb-6"
          aria-labelledby="account-title"
        >
          <h2 id="account-title" className="m-0 text-[15px] font-medium text-vn-text">
            Account
          </h2>
          <dl className="m-0 flex flex-wrap gap-5">
            <dt className="text-vn-muted">Signed in as</dt>
            <dd className="m-0 text-vn-secondary">{session?.user.email ?? "—"}</dd>
          </dl>
          <p className="mb-0 mt-[5px] leading-[1.7] text-vn-muted">
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
