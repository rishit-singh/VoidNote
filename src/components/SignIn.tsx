"use client";

import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function SignIn({ message, className }: { message?: string; className?: string }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setError("");
    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
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
        Get an email link to securely save your notes and profiles. Open the link in this browser.
      </p>
      {message && (
        <p role="status" className="m-0 text-sm leading-[1.7] text-vn-muted">
          {message}
        </p>
      )}
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3.5"
        aria-busy={state === "sending"}
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
              disabled={state === "sending"}
              aria-describedby={`${id}-help ${id}-status`}
              variant="signin"
            />
          </Field>
        </FieldGroup>
        <Button type="submit" disabled={state === "sending"}>
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
