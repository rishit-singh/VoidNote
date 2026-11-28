"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  contactFieldsSchema,
  type ContactDetails,
  type SaveContactDetails,
} from "@/contracts/contacts";
import { getQueryRuntime, notifyQueryChange } from "@/lib/query-runtime";

export function ContactDetailsEditor({
  workspaceId,
  personId,
}: {
  workspaceId: string;
  personId: string;
}) {
  const runtime = getQueryRuntime();
  const scope = { workspaceId, personId };
  const query = useQuery(runtime.trpc.contacts.get.queryOptions(scope));
  const [draft, setDraft] = useState<ContactDetails | null>(null);
  const [pending, setPending] = useState<SaveContactDetails | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const save = useMutation(
    runtime.trpc.contacts.save.mutationOptions({
      onSuccess(result) {
        if (getQueryRuntime() !== runtime) {
          return;
        }

        runtime.queryClient.setQueryData(runtime.trpc.contacts.get.queryKey(scope), (current) =>
          current && current.revision > result.revision ? current : result,
        );
        setDraft(null);
        setPending(null);
        void notifyQueryChange("contacts", { workspaceId, id: personId }, runtime, true);
      },
    }),
  );
  const value = draft ?? query.data;

  if (!value) {
    return query.isError ? (
      <Alert variant="destructive">
        <AlertDescription>
          Contact details could not be loaded.
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    ) : (
      <Skeleton className="h-32 w-full" />
    );
  }

  const current = value;
  const locked = save.isPending || pending !== null;

  function submit() {
    if (pending) {
      save.mutate(pending);

      return;
    }

    const fields = contactFieldsSchema.safeParse(current);

    if (!fields.success) {
      setValidation(fields.error.issues[0]?.message ?? "Check contact details.");

      return;
    }

    const command = {
      ...scope,
      operationId: crypto.randomUUID(),
      expectedRevision: current.revision,
      fields: fields.data,
    };

    setValidation(null);
    setPending(command);
    save.mutate(command);
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`organization-${personId}`}>Organization</FieldLabel>
          <Input
            id={`organization-${personId}`}
            value={current.organization}
            maxLength={200}
            disabled={locked}
            onChange={(event) => setDraft({ ...current, organization: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`role-${personId}`}>Role</FieldLabel>
          <Input
            id={`role-${personId}`}
            value={current.role}
            maxLength={200}
            disabled={locked}
            onChange={(event) => setDraft({ ...current, role: event.target.value })}
          />
        </Field>
        {current.links.map((link, index) => (
          <Field key={index}>
            <FieldLabel htmlFor={`contact-link-${personId}-${index}`}>
              Website or social profile {index + 1}
            </FieldLabel>
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label={`Link ${index + 1} label`}
                value={link.label}
                maxLength={80}
                className="flex-1"
                disabled={locked}
                onChange={(event) =>
                  setDraft({
                    ...current,
                    links: current.links.map((item, position) =>
                      position === index ? { ...item, label: event.target.value } : item,
                    ),
                  })
                }
              />
              <Input
                id={`contact-link-${personId}-${index}`}
                type="url"
                value={link.url}
                maxLength={2000}
                className="flex-[2]"
                disabled={locked}
                onChange={(event) =>
                  setDraft({
                    ...current,
                    links: current.links.map((item, position) =>
                      position === index ? { ...item, url: event.target.value } : item,
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                disabled={locked}
                aria-label={`Remove link ${index + 1}`}
                onClick={() =>
                  setDraft({
                    ...current,
                    links: current.links.filter((_, position) => position !== index),
                  })
                }
              >
                Remove
              </Button>
            </div>
          </Field>
        ))}
      </FieldGroup>
      {(validation || save.isError) && (
        <Alert variant="destructive">
          <AlertDescription>{validation ?? save.error?.message}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={locked || current.links.length >= 12}
          onClick={() =>
            setDraft({ ...current, links: [...current.links, { label: "Website", url: "" }] })
          }
        >
          Add link
        </Button>
        <Button type="submit" disabled={save.isPending || (!draft && !pending)}>
          {save.isPending ? "Saving…" : pending ? "Retry save" : "Save contact details"}
        </Button>
        {pending && !save.isPending && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setPending(null);
              setDraft(null);
              save.reset();
              void query.refetch();
            }}
          >
            Reload saved details
          </Button>
        )}
      </div>
    </form>
  );
}
