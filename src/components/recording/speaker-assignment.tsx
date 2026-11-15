"use client";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Plus, UserRound, UserRoundX } from "lucide-react";
import type { Assignment, CorrectedTurn } from "@/contracts/transcript-corrections";
import type { SavePerson } from "@/contracts/workspace";
import { peopleQueryOptions } from "@/queries/people";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type {
  CorrectionPreviewOptions,
  TranscriptCorrections,
} from "@/hooks/use-transcript-corrections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

export type SpeakerChoice = Exclude<Assignment, { kind: "unassigned" }>;
export function SpeakerAssignment({
  turn,
  api,
  onSaved,
  onAssign,
  disabled = false,
}: {
  turn: CorrectedTurn;
  api: TranscriptCorrections;
  onSaved: () => void;
  onAssign?:
    | ((
        assignment: SpeakerChoice,
        guest?: SavePerson,
        options?: CorrectionPreviewOptions,
      ) => Promise<boolean>)
    | undefined;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const locked = disabled || api.busy || !!api.pending || !api.ready;
  const { owned, workspaceId } = api;
  const search = useDebouncedValue(query.trim());
  const people = useInfiniteQuery(peopleQueryOptions(workspaceId, search));
  const page = {
    items: people.data?.pages.flatMap((part) => part.items) ?? [],
    nextCursor: people.data?.pages.at(-1)?.nextCursor,
  };
  const loading = people.isFetching || search !== query.trim();
  const error = people.error?.message;
  async function assign(assignment: SpeakerChoice, guest?: SavePerson) {
    if (locked) return;
    const personName =
      guest?.content.displayName ??
      (assignment.kind === "person"
        ? page.items.find((person) => person.id === assignment.personId)?.displayName
        : undefined);
    const options: CorrectionPreviewOptions = {
      ...(personName ? { personName } : {}),
      onPending: onSaved,
    };
    const saved = onAssign
      ? await onAssign(assignment, guest, options)
      : await api.submit(
          {
            kind: "assign",
            commandId: crypto.randomUUID(),
            targets: [{ id: turn.id, expectedAttributionRevision: turn.attributionRevision }],
            assignment,
          },
          guest,
          options,
        );
    if (saved && owned()) onSaved();
  }
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="speaker-search" className="sr-only">
            Search or create a speaker
          </FieldLabel>
          <Input
            id="speaker-search"
            autoFocus
            placeholder="Search or create a speaker…"
            maxLength={200}
            value={query}
            disabled={locked}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </Field>
      </FieldGroup>
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto" aria-label="Speakers">
        <Button
          variant="ghost"
          className="justify-start"
          disabled={locked}
          onClick={() => void assign({ kind: "unknown" })}
        >
          <UserRoundX />
          Unknown speaker
        </Button>
        {page.items.map((person) => (
          <Button
            key={person.id}
            variant="ghost"
            className="justify-start"
            disabled={locked}
            aria-label={`Select ${person.displayName}`}
            onClick={() => void assign({ kind: "person", personId: person.id })}
          >
            <UserRound />
            <span className="truncate">{person.displayName}</span>
          </Button>
        ))}
        {loading && <Skeleton className="h-9 w-full" aria-label="Loading speakers" />}
        {query.trim() && (
          <Button
            variant="outline"
            className="justify-start"
            disabled={locked}
            onClick={() => {
              const id = crypto.randomUUID();
              void assign(
                { kind: "person", personId: id },
                {
                  id,
                  commandId: crypto.randomUUID(),
                  expectedRevision: 0,
                  content: { displayName: query.trim(), description: "" },
                },
              );
            }}
          >
            <Plus />
            <span className="truncate">Create “{query.trim()}”</span>
          </Button>
        )}
        {page.nextCursor && (
          <Button
            variant="link"
            disabled={loading || locked}
            onClick={() => void people.fetchNextPage()}
          >
            More speakers
          </Button>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            <Button variant="link" onClick={() => void people.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
