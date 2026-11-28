"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { People } from "@/components/People";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PersonListItem } from "@/contracts/people";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { peopleQueryOptions } from "@/queries/people";
import { selfProfileQueryOptions, useSelfProfileMutation } from "@/queries/self-profile";
import { useNoteStore } from "@/stores/use-note-store";

export function MyProfile() {
  const session = useNoteStore((state) => state.session);
  const epoch = useNoteStore((state) => state.epoch);
  if (!session) return null;

  return (
    <MyProfileScope
      key={`${epoch}:${session.user.id}:${session.workspace.id}`}
      workspaceId={session.workspace.id}
      workspaceName={session.workspace.name}
    />
  );
}

function MyProfileScope({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const self = useQuery(selfProfileQueryOptions(workspaceId));
  const mutation = useSelfProfileMutation();
  const ready = useNoteStore((state) => state.status === "ready");
  const [name, setName] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selection, setSelection] = useState<PersonListItem | null>(null);
  const current = self.data && !self.data.deletedAt ? self.data : null;
  const retry = !mutation.isPending && mutation.pending;
  const awaitingRefresh =
    mutation.isSuccess && (self.isFetching || self.dataUpdatedAt <= mutation.submittedAt);
  const locked =
    !ready || mutation.isPending || awaitingRefresh || !!retry || !!mutation.recoveryError;

  function link(person: PersonListItem) {
    mutation.mutate({
      kind: "link",
      input: {
        workspaceId,
        commandId: crypto.randomUUID(),
        personId: person.id,
        expectedRevision: person.revision,
        expectedSelfId: current?.id ?? null,
      },
    });
    setPickerOpen(false);
    setSelection(null);
  }

  return (
    <section className="mx-auto flex w-full max-w-[880px] flex-[1_0_auto] flex-col gap-6 px-10 pb-10 [@media(max-width:760px)]:px-6">
      <header className="sticky top-0 z-20 flex h-[var(--workspace-header-height)] flex-none items-center bg-vn-page pb-5 pt-10 [@media(max-width:760px)]:pb-4 [@media(max-width:760px)]:pt-[30px]">
        <h1 className="m-0 text-title text-vn-text">My profile</h1>
      </header>
      <div className="flex flex-col gap-2">
        <p className="m-0 text-muted-foreground">{workspaceName}</p>
        <p className="m-0 text-muted-foreground">
          Your workspace profile, separate from your{" "}
          <Link href="/settings" className="underline">
            sign-in account
          </Link>
          .
        </p>
      </div>
      {mutation.isPending && <p role="status">Updating My profile…</p>}
      {mutation.isSuccess && (
        <p role="status">Profile change saved.{self.isFetching ? " Refreshing My profile…" : ""}</p>
      )}
      {(mutation.isError || retry || mutation.recoveryError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {mutation.recoveryError ??
              mutation.error?.message ??
              "A saved profile change needs confirmation."}
            {retry && (
              <Button variant="link" onClick={() => mutation.mutate(retry)}>
                Retry profile change
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {self.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            My profile could not be loaded.
            <Button variant="link" onClick={() => void self.refetch()}>
              Retry My profile
            </Button>
          </AlertDescription>
        </Alert>
      ) : self.isPending ? (
        <p role="status">Loading My profile…</p>
      ) : (
        <>
          {current ? (
            <People key={current.id} profileId={current.id} editorOnly />
          ) : (
            <form
              className="flex max-w-lg flex-col items-start gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (locked || !name.trim()) return;
                mutation.mutate({
                  kind: "create",
                  input: {
                    workspaceId,
                    commandId: crypto.randomUUID(),
                    displayName: name.trim(),
                  },
                });
              }}
            >
              <FieldGroup>
                <Field data-disabled={locked}>
                  <FieldLabel htmlFor="self-profile-name">Your name</FieldLabel>
                  <Input
                    id="self-profile-name"
                    variant="workspace"
                    autoComplete="name"
                    value={name}
                    required
                    maxLength={200}
                    disabled={locked}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              <Button type="submit" disabled={locked || !name.trim()}>
                {mutation.isPending ? "Creating My profile…" : "Create My profile"}
              </Button>
            </form>
          )}
          <Button
            className="self-start"
            variant="ghost"
            disabled={locked}
            onClick={() => {
              setSelection(null);
              setPickerOpen(true);
            }}
          >
            Use an existing profile
          </Button>
          <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
            <DialogContent className="flex max-h-[calc(100dvh-32px)] flex-col overflow-hidden">
              <DialogHeader className="shrink-0 pr-6">
                <DialogTitle>
                  {selection ? "Replace My profile?" : "Use an existing profile"}
                </DialogTitle>
              </DialogHeader>
              <DialogDescription className="min-h-0 overflow-y-auto">
                {selection
                  ? `Use ${selection.displayName} instead of ${current?.displayName} as My profile in ${workspaceName}? Both profiles and their recording assignments will be preserved.`
                  : `Choose your profile in ${workspaceName}.`}
              </DialogDescription>
              {selection ? (
                <div className="flex shrink-0 justify-end gap-2">
                  <Button variant="outline" onClick={() => setSelection(null)}>
                    Back
                  </Button>
                  <Button disabled={locked} onClick={() => link(selection)}>
                    Replace My profile
                  </Button>
                </div>
              ) : (
                <ExistingProfilePicker
                  workspaceId={workspaceId}
                  currentId={current?.id}
                  disabled={locked}
                  onSelect={(person) => (current ? setSelection(person) : link(person))}
                />
              )}
            </DialogContent>
          </Dialog>
        </>
      )}
    </section>
  );
}

function ExistingProfilePicker({
  workspaceId,
  currentId,
  disabled,
  onSelect,
}: {
  workspaceId: string;
  currentId: string | undefined;
  disabled: boolean;
  onSelect: (person: PersonListItem) => void;
}) {
  const [search, setSearch] = useState("");
  const results = useInfiniteQuery(
    peopleQueryOptions(workspaceId, useDebouncedValue(search.trim())),
  );
  const people =
    results.data?.pages
      .flatMap((page) => page.items)
      .filter((person) => !person.deletedAt && person.id !== currentId) ?? [];
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto [&>*]:shrink-0">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="self-profile-search">Search profiles</FieldLabel>
          <Input
            id="self-profile-search"
            type="search"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
      </FieldGroup>
      {results.isFetching && <p role="status">Loading profiles…</p>}
      {results.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            Profiles could not be loaded.
            <Button variant="link" onClick={() => void results.refetch()}>
              Retry profiles
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        {people.map((person) => (
          <Button
            key={person.id}
            variant="outline"
            className="justify-start"
            disabled={disabled}
            onClick={() => onSelect(person)}
          >
            {person.displayName}
          </Button>
        ))}
      </div>
      {!results.isFetching && !results.isError && !people.length && <p>No matching profiles.</p>}
      {results.hasNextPage && (
        <Button
          variant="ghost"
          disabled={results.isFetching}
          onClick={() => void results.fetchNextPage()}
        >
          Load more profiles
        </Button>
      )}
    </div>
  );
}
