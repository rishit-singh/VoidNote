"use client";

import { ExclamationTriangleIcon, SpeakerLoudIcon } from "@radix-ui/react-icons";
import { useNoteStore } from "@/stores/use-note-store";
import { RecordingSettings } from "@/components/recording";
import { Button } from "@/components/ui/button";
import { AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConnectorSettings } from "@/components/connectors";

export function Settings() {
  const session = useNoteStore((state) => state.session);
  const recoveryError = useNoteStore((state) => state.recoveryError);
  return (
    <section
      className="mx-auto flex w-full max-w-[880px] flex-[1_0_auto] flex-col gap-8 px-10 pb-10 [@media(max-width:760px)]:gap-[22px] [@media(max-width:760px)]:px-6 [@media(max-width:760px)]:pb-8"
      aria-labelledby="settings-title"
    >
      <header className="sticky top-0 z-20 flex h-[var(--workspace-header-height)] flex-none items-center justify-between gap-4 bg-vn-page pb-5 pt-10 [@media(max-width:760px)]:pb-4 [@media(max-width:760px)]:pt-[30px]">
        <h1
          id="settings-title"
          className="m-0 text-title text-vn-text [@media(max-width:760px)]:text-[24px]"
        >
          Settings
        </h1>
      </header>
      <div className="flex w-full flex-col divide-y divide-vn-stroke [&>section>:first-child]:sticky [&>section>:first-child]:top-[var(--workspace-header-height)] [&>section>:first-child]:z-10 [&>section>:first-child]:bg-vn-page [&>section>:first-child]:py-3">
        <section
          className="flex flex-col gap-5 py-7 first:pt-0"
          aria-labelledby="recording-settings-title"
        >
          <div className="flex items-start gap-3">
            <SpeakerLoudIcon className="mt-0.5 size-[17px] text-vn-muted" aria-hidden="true" />
            <div>
              <h2 id="recording-settings-title" className="m-0 text-base font-medium text-vn-text">
                Recording
              </h2>
            </div>
          </div>
          <RecordingSettings />
        </section>
        <section className="flex flex-col gap-4 py-7" aria-labelledby="privacy-title">
          <h2 id="privacy-title" className="m-0 text-base font-medium text-vn-text">
            Transcription and privacy
          </h2>
          <p className="m-0 max-w-[68ch] leading-[1.7] text-vn-muted">
            Browser live text uses the speech recognition service provided by your browser and may
            be processed online. Microphone audio is saved locally first. Upload & transcribe on a
            note saves a private remote copy and sends that audio to pyannoteAI for finalized
            processing.
          </p>
          <div className="flex max-w-[700px] items-start gap-2.5 rounded-sm border border-vn-stroke-strong px-3.5 py-3 text-vn-secondary">
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
        {session && (
          <ConnectorSettings
            key={`${session.user.id}:${session.workspace.id}`}
            userId={session.user.id}
            workspaceId={session.workspace.id}
          />
        )}
        <section className="flex flex-col gap-4 py-7" aria-labelledby="account-title">
          <h2 id="account-title" className="m-0 text-base font-medium text-vn-text">
            Account
          </h2>
          <dl className="m-0 grid max-w-[520px] grid-cols-[minmax(100px,140px)_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
            <dt className="text-vn-muted">Signed in as</dt>
            <dd className="m-0 break-all text-vn-secondary">{session?.user.email ?? "—"}</dd>
          </dl>
          <p className="m-0 max-w-[68ch] leading-[1.7] text-vn-muted">
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
