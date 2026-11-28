"use client";
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Plus, UserRound, UserRoundX } from "lucide-react";
import type { Assignment, CorrectedTurn } from "@/contracts/transcript-corrections";
import type { SavePerson } from "@/contracts/workspace";
import { peopleQueryOptions } from "@/queries/people";
import { selfProfileQueryOptions } from "@/queries/self-profile";
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
  passageTargets,
  allowPropagation = true,
}: {
  turn: CorrectedTurn;
  api: TranscriptCorrections;
  onSaved: () => void;
  onAssign?:
    | ((
        assignment: SpeakerChoice,
        guest?: SavePerson,
        options?: CorrectionPreviewOptions,
        targets?: { id: string; expectedAttributionRevision: number }[],
      ) => Promise<boolean>)
    | undefined;
  disabled?: boolean;
  passageTargets?: { id: string; expectedAttributionRevision: number }[] | undefined;
  allowPropagation?: boolean;
}) {
  const [choice, setChoice] = useState<{
    assignment: SpeakerChoice;
    guest?: SavePerson;
    personName?: string;
    selectedTargets: { id: string; expectedAttributionRevision: number }[];
  } | null>(null);
  const [query, setQuery] = useState("");
  const locked = disabled || api.busy || !!api.pending || !api.ready;
  const { owned, workspaceId } = api;
  const search = useDebouncedValue(query.trim());
  const people = useInfiniteQuery(peopleQueryOptions(workspaceId, search));
  const selfProfile = useQuery(selfProfileQueryOptions(workspaceId));
  const me = selfProfile.data && !selfProfile.data.deletedAt ? selfProfile.data : null;
  const page = {
    items: people.data?.pages.flatMap((part) => part.items) ?? [],
    nextCursor: people.data?.pages.at(-1)?.nextCursor,
  };
  const loading = people.isFetching || search !== query.trim();
  const error = people.error?.message;
  const previewParams = useMemo(
    () => new URLSearchParams({ speakerLabel: turn.speakerLabel }),
    [turn.speakerLabel],
  );
  const previews = useQueries({
    queries: [true, false].map((includeManual) => ({
      ...api.previewOptions(
        new URLSearchParams(`${previewParams.toString()}&includeManual=${String(includeManual)}`),
      ),
      enabled: choice !== null && allowPropagation,
    })),
  });
  const allPreview = previews[0]!;
  const unassignedPreview = previews[1]!;
  function assign(assignment: SpeakerChoice, guest?: SavePerson) {
    if (locked) return;
    const personName =
      guest?.content.displayName ??
      (assignment.kind === "person"
        ? me?.id === assignment.personId
          ? me.displayName
          : page.items.find((person) => person.id === assignment.personId)?.displayName
        : undefined);
    // Choosing only stages intent. The query is keyed by run and speaker label.
    setChoice({
      assignment,
      ...(guest ? { guest } : {}),
      ...(personName ? { personName } : {}),
      selectedTargets: passageTargets ?? [
        { id: turn.id, expectedAttributionRevision: turn.attributionRevision },
      ],
    });
  }
  async function confirm(all: boolean) {
    if (!choice || locked) return;
    const targets = all ? allPreview.data?.targets : choice.selectedTargets;
    if (!targets?.length) return;
    const options: CorrectionPreviewOptions = {
      ...(choice.personName ? { personName: choice.personName } : {}),
      onPending: onSaved,
    };
    const saved = onAssign
      ? await onAssign(choice.assignment, choice.guest, options, targets)
      : await api.submit(
          {
            kind: "assign",
            commandId: crypto.randomUUID(),
            targets,
            assignment: choice.assignment,
          },
          choice.guest,
          options,
        );
    setChoice(null);
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
        {me ? (
          <Button
            variant="ghost"
            className="justify-start"
            disabled={locked}
            aria-label={`Select Me (${me.displayName})`}
            onClick={() => assign({ kind: "person", personId: me.id })}
          >
            <UserRound data-icon="inline-start" />
            <span className="truncate">Me · {me.displayName}</span>
          </Button>
        ) : selfProfile.isPending ? (
          <Skeleton className="h-9 w-full" aria-label="Loading My profile" />
        ) : selfProfile.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              My profile could not be loaded.
              <Button variant="link" onClick={() => void selfProfile.refetch()}>
                Retry My profile
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Button asChild variant="ghost" className="justify-start">
            <Link href="/profiles">Set up My profile</Link>
          </Button>
        )}
        <Button
          variant="ghost"
          className="justify-start"
          disabled={locked}
          onClick={() => void assign({ kind: "unknown" })}
        >
          <UserRoundX />
          Unknown speaker
        </Button>
        {page.items
          .filter((person) => person.id !== me?.id)
          .map((person) => (
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
      {choice && (allPreview.error || unassignedPreview.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {allPreview.error instanceof Error
              ? allPreview.error.message
              : unassignedPreview.error instanceof Error
                ? unassignedPreview.error.message
                : "Could not preview matching segments."}{" "}
            Only this passage is still available.
          </AlertDescription>
        </Alert>
      )}
      {choice && (
        <div
          role="group"
          aria-label="Confirm speaker assignment"
          className="order-first flex flex-col gap-2"
        >
          <p className="text-body">
            Assign{" "}
            {choice.personName ??
              (choice.assignment.kind === "unknown" ? "Unknown speaker" : "speaker")}{" "}
            {allowPropagation
              ? "to matching segments in this recording?"
              : "to this selected speech?"}
          </p>
          {allowPropagation && (
            <Button
              disabled={
                locked ||
                allPreview.isFetching ||
                unassignedPreview.isFetching ||
                !allPreview.data?.targets.length
              }
              onClick={() => void confirm(true)}
            >
              All matching segments ({allPreview.data?.targets.length ?? "…"})
            </Button>
          )}
          {allowPropagation && (
            <p className="text-meta text-muted-foreground">
              {unassignedPreview.data
                ? `${unassignedPreview.data.targets.length} unassigned; ${unassignedPreview.data.excludedManualCount} existing manual assignments will change.`
                : "Loading matching segment details…"}
            </p>
          )}
          <Button variant="outline" disabled={locked} onClick={() => void confirm(false)}>
            Only this passage
          </Button>
          <Button variant="ghost" onClick={() => setChoice(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
