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
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
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
  const saveAll = useNoteStore((state) => state.saveAll);
  const captureStatus = useCaptureStore((state) => state.status);
  const captureActive = ["starting", "recording", "paused", "stopping"].includes(captureStatus);
  const selectedSection = activeSection(pathname);
  const noteId = pathname.startsWith("/notes/")
    ? decodeURIComponent(pathname.slice("/notes/".length))
    : null;
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const recentNotes = useRecentNotes();

  function startNewNote() {
    const created = createNote();
    router.push(`/notes/${encodeURIComponent(created.id)}`);
  }

  async function saveAndSignOut() {
    setSignOutError(null);
    try {
      const saved = await saveAll();
      if (!saved) {
        setSignOutError(
          "Some changes could not be saved. Resolve them or discard drafts before signing out.",
        );
        return;
      }
      await signOut();
      if (useNoteStore.getState().status !== "signedOut") {
        setSignOutError(
          useNoteStore.getState().error ?? "Sign-out could not be confirmed. Try again.",
        );
        return;
      }
      setSignOutOpen(false);
    } catch (failure) {
      setSignOutError(failure instanceof Error ? failure.message : "Unable to sign out.");
    }
  }

  async function discardAndSignOut() {
    await signOut(true);
    if (useNoteStore.getState().status !== "signedOut") {
      setSignOutError(
        useNoteStore.getState().error ?? "Sign-out could not be confirmed. Try again.",
      );
      return;
    }
    setSignOutOpen(false);
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
      <main className="vn-loading" aria-label="VoidNote workspace">
        <Skeleton className="h-8 w-56" role="status" aria-label="Opening your workspace" />
      </main>
    );
  }
  if (status === "signedOut") {
    return (
      <main className="vn-auth">
        <SignIn {...(error ? { message: error } : {})} />
        <Button variant="outline" onClick={() => void refreshSession()}>
          Check sign-in
        </Button>
      </main>
    );
  }
  if (!session && (status === "setup" || status === "error")) {
    return (
      <main className="vn-loading">
        <section className="vn-message">
          <h1>{status === "setup" ? "Workspace setup required" : "Unable to load workspace"}</h1>
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
        setSignOutOpen(open);
        if (!open) setSignOutError(null);
      }}
    >
      <div className="vn-app">
        <RecordingController noteId={noteId ?? undefined} />
        <aside className="vn-sidebar" aria-label="Primary navigation">
          <Link href="/" className="vn-brand" aria-label="VoidNote home">
            voidnote
          </Link>
          {pathname !== "/" && (
            <Button
              className="vn-new-note"
              variant="outline"
              aria-label="New note"
              disabled={status !== "ready"}
              onClick={startNewNote}
            >
              <PlusIcon aria-hidden="true" />
              New note
            </Button>
          )}
          <nav className="vn-side-nav" aria-label="Workspace">
            {navigation.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn("vn-nav-link", selectedSection === href && "is-active")}
                aria-current={selectedSection === href ? "page" : undefined}
              >
                <Icon aria-hidden="true" />
                {label}
              </Link>
            ))}
          </nav>
          {pathname !== "/" && (
            <div className="vn-recent">
              <p className="vn-section-label">Notes</p>
              {recentNotes.map((item) => (
                <Link
                  key={item.id}
                  href={`/notes/${encodeURIComponent(item.id)}`}
                  className={cn("vn-recent-link", item.id === noteId && "is-active")}
                >
                  {item.title || "Untitled note"}
                  {edits[`note:${item.id}`]?.dirty && <span aria-label="Unsaved changes"> ·</span>}
                </Link>
              ))}
            </div>
          )}
          <div className="vn-sidebar-bottom">
            <span className="vn-user-email" title={session?.user.email ?? ""}>
              {session?.user.email}
            </span>
            <AlertDialogTrigger asChild>
              <Button className="vn-signout" variant="ghost">
                <ExitIcon aria-hidden="true" />
                Sign out
              </Button>
            </AlertDialogTrigger>
          </div>
        </aside>
        <main
          className="vn-main"
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
          {recoveryError && (
            <Alert variant="destructive" className="vn-inline-notice">
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
            <Alert variant="destructive" className="vn-inline-notice">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {recoveryHydration === "loading" && (
            <p role="status" className="vn-inline-status">
              Recovering saved drafts…
            </p>
          )}
          {!!recoveredDraftCount && (
            <p className="vn-inline-status" role="status">
              Recovered {recoveredDraftCount} draft{recoveredDraftCount === 1 ? "" : "s"} from this
              device.
            </p>
          )}
          {children}
          <RecordingDock {...(noteId ? { noteId } : {})} />
        </main>
        <nav className="vn-mobile-nav" aria-label="Mobile workspace navigation">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(selectedSection === href && "is-active")}
              aria-current={selectedSection === href ? "page" : undefined}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
      </div>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out of VoidNote?</AlertDialogTitle>
          <AlertDialogDescription>
            {captureActive
              ? "Stop the active recording before signing out. Its audio is being saved locally."
              : "Drafts are stored on this device for recovery, not in your account. Browser storage can be cleared or unavailable."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {recoveryError && (
          <Alert variant="destructive">
            <AlertDescription>Local recovery warning: {recoveryError}</AlertDescription>
          </Alert>
        )}
        {signOutError && (
          <Alert variant="destructive">
            <AlertDescription>{signOutError}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            disabled={captureActive}
            onClick={() => void discardAndSignOut()}
          >
            Discard and sign out
          </Button>
          <AlertDialogAction
            disabled={captureActive}
            onClick={(event) => {
              event.preventDefault();
              void saveAndSignOut();
            }}
          >
            Save and sign out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
