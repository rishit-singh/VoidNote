"use client";

import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function SignIn({ message }: { message?: string }) {
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
    <section aria-labelledby={`${id}-title`} className="vn-signin">
      <h1 id={`${id}-title`} className="text-xl font-semibold">
        Sign in to VoidNote
      </h1>
      <p id={`${id}-help`} className="text-sm text-muted-foreground">
        Get an email link to securely save your notes and profiles. Open the link in this browser.
      </p>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
        aria-busy={state === "sending"}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-email`}>Email address</FieldLabel>
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
              className="vn-input"
            />
          </Field>
        </FieldGroup>
        <Button type="submit" disabled={state === "sending"} className="vn-signin-submit">
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
