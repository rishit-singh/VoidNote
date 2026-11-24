"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ExitIcon, GearIcon, HomeIcon, PersonIcon, PlusIcon } from "@radix-ui/react-icons";

import { SignIn } from "@/components/SignIn";
import { LandingPage } from "@/components/landing/LandingPage";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useNoteStore } from "@/stores/use-note-store";
import { useCaptureStore } from "@/stores/use-capture-store";
import { cn } from "@/lib/utils";
import { RecordingController, RecordingDock } from "@/components/recording";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRecentNotes } from "@/hooks/use-recent-notes";

const navigation = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/profiles", label: "Profiles", icon: PersonIcon },
  { href: "/settings", label: "Settings", icon: GearIcon },
] as const;

function activeSection(path: string) {
  if (path.startsWith("/profiles")) return "/profiles";
  if (path.startsWith("/settings")) return "/settings";
  return "/";
}

export default function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const {
    status,
    session,
    error,
    recoveryError,
    recoveryHydration,
    retryRecovery,
    recoveredDraftCount,
    refreshSession,
  } = useWorkspace();
  const edits = useNoteStore((state) => state.edits);
  const createNote = useNoteStore((state) => state.createNote);
  const signOut = useNoteStore((state) => state.signOut);
  const captureStatus = useCaptureStore((state) => state.status);
  const captureActive = ["starting", "recording", "paused", "stopping"].includes(captureStatus);
  const selectedSection = activeSection(pathname);
  const noteId = pathname.startsWith("/notes/")
    ? decodeURIComponent(pathname.slice("/notes/".length))
    : null;
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const recentNotes = useRecentNotes();

  function startNewNote() {
    const created = createNote();
    router.push(`/notes/${encodeURIComponent(created.id)}`);
  }

  async function requestSignOut() {
    if (signingOut) return;
    setSignOutError(null);
    if (
      ["starting", "recording", "paused", "stopping"].includes(useCaptureStore.getState().status)
    ) {
      setSignOutOpen(true);
      return;
    }
    setSigningOut(true);
    try {
      await signOut();
      if (useNoteStore.getState().status !== "signedOut") {
        setSignOutError(
          useNoteStore.getState().error ?? "Sign-out could not be confirmed. Try again.",
        );
        setSignOutOpen(true);
        return;
      }
      setSignOutOpen(false);
    } catch (failure) {
      setSignOutError(failure instanceof Error ? failure.message : "Unable to sign out.");
      setSignOutOpen(true);
    } finally {
      setSigningOut(false);
    }
  }

  if (!session && pathname === "/") {
    return (
      <LandingPage
        {...(error ? { message: error } : {})}
        onCheckSignIn={() => void refreshSession()}
      />
    );
  }

  if (!session && (status === "idle" || status === "loading")) {
    return (
      <main
        className="flex min-h-dvh items-center justify-center gap-5 bg-vn-page text-vn-muted"
        aria-label="VoidNote workspace"
      >
        <Skeleton className="h-8 w-56" role="status" aria-label="Opening your workspace" />
      </main>
    );
  }
  if (status === "signedOut") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-vn-page p-6 text-vn-muted">
        <SignIn {...(error ? { message: error } : {})} />
        <Button variant="outline" onClick={() => void refreshSession()}>
          Check sign-in
        </Button>
      </main>
    );
  }
  if (!session && (status === "setup" || status === "error")) {
    return (
      <main className="flex min-h-dvh items-center justify-center gap-5 bg-vn-page text-vn-muted">
        <section className="flex max-w-[480px] flex-col gap-4 p-6 [&_p]:m-0">
          <h1 className="m-0 text-[22px] font-medium text-vn-text">
            {status === "setup" ? "Workspace setup required" : "Unable to load workspace"}
          </h1>
          <Alert variant="destructive">
            <AlertDescription>{error ?? "Please try again shortly."}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => void refreshSession()}>
            Retry
          </Button>
        </section>
      </main>
    );
  }

  return (
    <AlertDialog
      open={signOutOpen}
      onOpenChange={(open) => {
        if (signingOut) return;
        setSignOutOpen(open);
        if (!open) setSignOutError(null);
      }}
    >
      <div
        inert={signingOut}
        className="flex h-dvh min-h-0 w-full overflow-hidden bg-vn-page font-mono text-body text-vn-text [&_:is(a,button,input,textarea):focus-visible]:outline [&_:is(a,button,input,textarea):focus-visible]:outline-2 [&_:is(a,button,input,textarea):focus-visible]:outline-offset-[3px] [&_:is(a,button,input,textarea):focus-visible]:outline-vn-secondary motion-reduce:[&_*]:!scroll-auto motion-reduce:[&_*]:![transition-duration:0.01ms] motion-reduce:[&_*::before]:!scroll-auto motion-reduce:[&_*::before]:![transition-duration:0.01ms] motion-reduce:[&_*::after]:!scroll-auto motion-reduce:[&_*::after]:![transition-duration:0.01ms] [@media(max-width:760px)]:flex-col"
      >
        <RecordingController noteId={noteId ?? undefined} />
        <aside
          className="flex min-h-0 flex-[0_0_224px] flex-col gap-6 overflow-y-auto border-r border-vn-divider bg-vn-sidebar px-4 pb-5 pt-7 [@media(max-width:760px)]:hidden"
          aria-label="Primary navigation"
        >
          <Link
            href="/"
            className="flex min-h-8 shrink-0 items-center px-3.5 text-[18px] font-medium tracking-[-0.04em] text-vn-text"
            aria-label="VoidNote home"
          >
            voidnote
          </Link>
          {pathname !== "/" && (
            <Button
              className="flex h-[38px] shrink-0 justify-start gap-2.5 px-3.5 py-0"
              variant="sidebar-outline"
              aria-label="New note"
              disabled={status !== "ready"}
              onClick={startNewNote}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              New note
            </Button>
          )}
          <nav className="flex shrink-0 flex-col gap-1" aria-label="Workspace">
            {navigation.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex h-[38px] items-center gap-3 rounded-[3px] px-3.5 text-label text-vn-muted transition-[background-color,color] duration-150 [transition-timing-function:ease] hover:bg-vn-hover hover:text-vn-text",
                  selectedSection === href && "bg-vn-hover text-vn-text",
                )}
                aria-current={selectedSection === href ? "page" : undefined}
              >
                <Icon className="size-4 flex-none stroke-[1.5]" aria-hidden="true" />
                {label}
              </Link>
            ))}
          </nav>
          {pathname !== "/" && (
            <section aria-label="Recent notes" className="flex min-h-20 flex-1 flex-col gap-0.5">
              <p className="mb-1.5 mt-0 shrink-0 px-3.5 pb-2 text-meta font-medium uppercase tracking-wider text-vn-muted">
                Notes
              </p>
              <div
                role="region"
                aria-label="Recent notes list"
                tabIndex={0}
                className="mr-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-3"
              >
                {recentNotes.map((item) => (
                  <Link
                    key={item.id}
                    href={`/notes/${encodeURIComponent(item.id)}`}
                    className="block truncate rounded-[3px] px-3.5 py-2.5 text-meta text-vn-secondary hover:bg-vn-hover hover:text-vn-text"
                  >
                    {item.title || "Untitled note"}
                    {edits[`note:${item.id}`]?.dirty && (
                      <span aria-label="Unsaved changes"> ·</span>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          )}
          <div className="mt-auto flex shrink-0 flex-col gap-2 border-t border-vn-stroke px-2 pt-3.5">
            <span className="truncate text-[11px] text-vn-muted" title={session?.user.email ?? ""}>
              {session?.user.email}
            </span>
            <Button
              className="justify-start gap-2.5 px-1.5 py-0"
              variant="workspace-ghost"
              disabled={signingOut}
              onClick={() => void requestSignOut()}
            >
              <ExitIcon data-icon="inline-start" aria-hidden="true" />
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </aside>
        <main
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          id="main-content"
          aria-label={
            pathname.startsWith("/notes/")
              ? "Note editor"
              : selectedSection === "/profiles"
                ? "Profiles"
                : selectedSection === "/settings"
                  ? "Settings"
                  : "Notes"
          }
        >
          <div className="max-h-[20dvh] shrink-0 overflow-y-auto">
            {recoveryError && (
              <Alert variant="notice">
                <AlertDescription>
                  {recoveryError}
                  {recoveryHydration === "error" && (
                    <Button variant="link" onClick={() => void retryRecovery()}>
                      Retry recovery
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="notice">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {recoveryHydration === "loading" && (
              <p role="status" className="m-0 px-6 text-vn-muted">
                Recovering saved drafts…
              </p>
            )}
            {!!recoveredDraftCount && (
              <p className="m-0 px-6 text-vn-muted" role="status">
                Recovered {recoveredDraftCount} draft{recoveredDraftCount === 1 ? "" : "s"} from
                this device.
              </p>
            )}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
          <RecordingDock {...(noteId ? { noteId } : {})} />
        </main>
        <nav
          className="hidden min-h-[calc(56px+env(safe-area-inset-bottom))] shrink-0 items-center justify-around border-t border-vn-stroke bg-vn-sidebar px-3.5 pb-[env(safe-area-inset-bottom)] pt-1 [@media(max-width:760px)]:flex"
          aria-label="Mobile workspace navigation"
        >
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex min-h-11 min-w-16 flex-col items-center justify-center gap-0.5 text-[10px] text-vn-muted",
                selectedSection === href && "text-vn-text",
              )}
              aria-current={selectedSection === href ? "page" : undefined}
            >
              <Icon className="size-[17px]" aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
      </div>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {captureActive ? "Recording in progress" : "Sign out"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {captureActive
              ? "Stop recording before signing out."
              : "Your unsynced changes stay on this device for your next sign-in."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {signOutError && (
          <Alert variant="destructive">
            <AlertDescription>{signOutError}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={signingOut}>Back</AlertDialogCancel>
          <Button disabled={captureActive || signingOut} onClick={() => void requestSignOut()}>
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
