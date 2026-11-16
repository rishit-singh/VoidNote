"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function SignIn({
  message,
  className,
  onPendingChange,
}: {
  message?: string;
  className?: string;
  onPendingChange?: (pending: boolean) => void;
}) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<"google" | "github" | null>(null);
  const busy = state === "sending" || provider !== null;
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    onPendingChange?.(busy);
  }, [busy, onPendingChange]);

  useEffect(() => {
    function restore(event: PageTransitionEvent) {
      if (event.persisted) setProvider(null);
    }

    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pageshow", restore);
      requestController.current?.abort();
      onPendingChange?.(false);
    };
  }, [onPendingChange]);

  async function signInWithProvider(selected: "google" | "github") {
    if (busy) return;
    setProvider(selected);
    setState("idle");
    setError("");
    const controller = new AbortController();
    requestController.current = controller;

    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selected }),
        signal: controller.signal,
      });
      const body: unknown = await response.json();

      if (
        !response.ok ||
        !body ||
        typeof body !== "object" ||
        !("url" in body) ||
        typeof body.url !== "string"
      ) {
        throw new Error("Unable to start sign-in");
      }

      if (!controller.signal.aborted) window.location.assign(body.url);
    } catch {
      if (controller.signal.aborted) return;
      setProvider(null);
      setError("Unable to start sign-in. Check your connection and try again.");
      setState("error");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setState("sending");
    setError("");
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const code = body && typeof body === "object" && "error" in body ? body.error : null;
        setError(
          code === "auth_not_configured"
            ? "Sign-in is not configured yet."
            : code === "invalid_request"
              ? "Enter a valid email address."
              : "Unable to send a sign-in link. Try again shortly.",
        );
        setState("error");
        return;
      }
      setState("sent");
    } catch {
      if (controller.signal.aborted) return;
      setError("Unable to connect. Check your connection and try again.");
      setState("error");
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex w-[min(100%,440px)] flex-col gap-[18px] p-8 [@media(max-width:760px)]:px-5 [@media(max-width:760px)]:py-7",
        className,
      )}
    >
      <h1 id={`${id}-title`} className="m-0 text-[22px] font-medium leading-7 text-vn-text">
        Sign in to VoidNote
      </h1>
      <p id={`${id}-help`} className="m-0 text-sm leading-[1.7] text-vn-muted">
        Sign in to securely save your notes and profiles. If you use an email link, open it in this
        browser.
      </p>
      {message && (
        <p role="status" className="m-0 text-sm leading-[1.7] text-vn-muted">
          {message}
        </p>
      )}
      <div
        className="flex flex-col gap-2"
        aria-label="Provider sign-in"
        aria-busy={provider !== null}
      >
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void signInWithProvider("google")}
        >
          {provider === "google" ? "Connecting to Google…" : "Continue with Google"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Or use an email link</p>
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3.5"
        aria-busy={busy}
      >
        <FieldGroup>
          <Field className="gap-2">
            <FieldLabel variant="signin" htmlFor={`${id}-email`}>
              Email address
            </FieldLabel>
            <Input
              id={`${id}-email`}
              name="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={254}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (state !== "sending") setState("idle");
              }}
              disabled={busy}
              aria-describedby={`${id}-help ${id}-status`}
              variant="signin"
            />
          </Field>
        </FieldGroup>
        <Button type="submit" disabled={busy}>
          {state === "sending"
            ? "Sending…"
            : state === "sent"
              ? "Send another link"
              : "Send sign-in link"}
        </Button>
        <p
          id={`${id}-status`}
          role={state === "error" ? "alert" : "status"}
          className="text-sm text-muted-foreground"
        >
          {state === "sent"
            ? "Check your email for a sign-in link. You can close this message once you sign in."
            : state === "error"
              ? error
              : ""}
        </p>
      </form>
    </section>
  );
}

export default SignIn;
