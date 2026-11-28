"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getQueryRuntime } from "@/lib/query-runtime";
import { ApiError, asApiError } from "@/lib/api-error";
import { peopleQueryOptions } from "@/queries/people";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PERSON_DESCRIPTION_PREVIEW_LENGTH } from "@/contracts/people";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";

import { SaveControls } from "@/components/History";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useNoteStore } from "@/stores/use-note-store";
import { PersonAppearances } from "@/components/person-appearances";
import { ContactDetailsEditor } from "@/components/contacts";
import { ContactResearchPanel } from "@/components/research";

export function People({
  profileId,
  editorOnly = false,
}: {
  profileId?: string;
  editorOnly?: boolean;
}) {
  const router = useRouter();
  const people = useNoteStore((state) => state.people);
  const personRecords = useNoteStore((state) => state.personRecords);
  const currentId = useNoteStore((state) => state.currentPersonId);
  const edits = useNoteStore((state) => state.edits);
  const unavailableRecords = useNoteStore((state) => state.unavailable);
  const createPerson = useNoteStore((state) => state.createPerson);
  const ready = useNoteStore((state) => state.status === "ready");
  const selectPerson = useNoteStore((state) => state.selectPerson);
  const updatePerson = useNoteStore((state) => state.updatePerson);
  const session = useNoteStore((state) => state.session);
  const epoch = useNoteStore((state) => state.epoch);
  const [search, setSearch] = useState("");
  const results = useInfiniteQuery({
    ...peopleQueryOptions(session?.workspace.id, useDebouncedValue(search.trim())),
    enabled: !!session && !editorOnly,
  });
  const loading = results.isFetching;
  const cursor = results.hasNextPage;
  const error = results.error?.message;
  const selectedId = profileId ?? currentId;
  const storedUnavailable = useNoteStore((state) =>
    selectedId ? state.unavailable[`person:${selectedId}`] : undefined,
  );
  const draft = people.find((entry) => entry.id === selectedId);
  const detail = useQuery(
    getQueryRuntime().trpc.people.get.queryOptions(
      { workspaceId: session?.workspace.id ?? "", id: selectedId ?? "", includeDeleted: false },
      {
        enabled: !!session && !!selectedId && (!draft || !!personRecords[draft.id]),
        trpc: { abortOnUnmount: true },
      },
    ),
  );
  const failure = detail.status === "error" && detail.error ? asApiError(detail.error) : null;
  const detailUnavailable =
    failure instanceof ApiError && [403, 404].includes(failure.status)
      ? failure.status === 403
        ? "forbidden"
        : "missing"
      : undefined;
  const unavailableReason =
    detailUnavailable ?? (detail.data?.deletedAt ? "missing" : storedUnavailable);
  const missing = !!unavailableReason;
  const unavailable: Record<string, string> = unavailableReason
    ? { [`person:${selectedId}`]: unavailableReason }
    : {};
  const recordError = failure?.message;
  const edit = selectedId ? edits[`person:${selectedId}`] : undefined;
  const person = missing
    ? undefined
    : detail.status === "success" && detail.data && !edit?.dirty && !edit?.pending
      ? { ...detail.data, scopeEpoch: epoch }
      : draft;
  const locked = edit?.pending?.kind === "delete" || (!!edit?.saving && !edit.pending);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const drafts = people.filter(
    (entry) =>
      edits[`person:${entry.id}`]?.dirty ||
      edits[`person:${entry.id}`]?.pending ||
      !personRecords[entry.id],
  );
  const draftIds = new Set(drafts.map((entry) => entry.id));
  const filteredPeople = [
    ...drafts.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      descriptionPreview: Array.from(entry.description)
        .slice(0, PERSON_DESCRIPTION_PREVIEW_LENGTH)
        .join(""),
    })),
    ...(results.data?.pages.flatMap((page) => page.items) ?? []).filter(
      (entry) => !draftIds.has(entry.id),
    ),
  ].filter(
    (entry) =>
      !unavailableRecords[`person:${entry.id}`] &&
      (entry.displayName || "Untitled profile").toLocaleLowerCase().startsWith(normalizedSearch),
  );

  useEffect(() => {
    const state = useNoteStore.getState();
    if (state.epoch !== epoch) return;
    if (detailUnavailable && selectedId)
      state.reconcileUnavailable(
        "person",
        selectedId,
        detailUnavailable,
        epoch,
        detail.errorUpdatedAt,
      );
    else if (detail.status === "success" && !detail.error && detail.data)
      state.reconcilePerson(detail.data, epoch, detail.dataUpdatedAt);
    if (profileId) selectPerson(profileId);
  }, [
    profileId,
    selectedId,
    detail.data,
    detail.status,
    detail.error,
    detail.dataUpdatedAt,
    detail.errorUpdatedAt,
    detailUnavailable,
    epoch,
    selectPerson,
  ]);

  function createProfile() {
    const created = createPerson();
    router.push(`/profiles/${encodeURIComponent(created.id)}`);
  }

  return (
    <section
      className={cn(
        "group/profiles mx-0 flex w-full max-w-none flex-[1_0_auto] flex-col",
        !editorOnly &&
          "min-[1101px]:min-h-0 min-[1101px]:flex-[1_1_0%] px-[clamp(24px,4vw,56px)] pb-8 [@media(max-width:760px)]:px-6",
      )}
      data-detail={!!profileId}
      aria-label={editorOnly ? "Profile editor" : "Profiles"}
    >
      {!editorOnly && (
        <header className="sticky top-0 z-20 flex h-[var(--workspace-header-height)] flex-none items-center justify-between gap-4 bg-vn-page pb-5 pt-10 [@media(max-width:760px)]:pb-4 [@media(max-width:760px)]:pt-[30px]">
          <div className="flex items-center gap-4">
            {profileId && (
              <Link href="/profiles" className="text-[12px] text-vn-muted min-[1101px]:hidden">
                ← Profiles
              </Link>
            )}
            <h1
              id="profiles-title"
              className="m-0 text-title text-vn-text [@media(max-width:760px)]:text-[24px]"
            >
              Profiles
            </h1>
          </div>
          <Button
            variant="workspace-outline"
            className="h-11"
            aria-label="New profile"
            disabled={!ready}
            onClick={createProfile}
          >
            + New
          </Button>
        </header>
      )}
      <div
        className={cn(
          "grid min-h-0 gap-12 [@media(max-width:760px)]:gap-[18px]",
          editorOnly
            ? "grid-cols-[minmax(0,1fr)]"
            : "min-[1101px]:flex-1 grid-cols-[minmax(250px,340px)_minmax(0,1fr)] [@media(max-width:1100px)]:grid-cols-[minmax(0,1fr)]",
        )}
      >
        {!editorOnly && (
          <aside
            className="flex min-h-0 flex-col items-stretch min-[1101px]:overflow-y-auto [@media(max-width:1100px)]:group-data-[detail=true]/profiles:hidden"
            aria-label="Profiles"
          >
            <div className="sticky top-[var(--workspace-header-height)] z-10 flex-none bg-vn-page pb-4 min-[1101px]:top-0">
              <div className="flex h-[46px] flex-none items-center gap-3 rounded-[4px] border border-vn-stroke px-3.5">
                <MagnifyingGlassIcon
                  className="size-4 flex-none fill-none stroke-vn-muted stroke-[1.2]"
                  aria-hidden="true"
                />
                <label className="sr-only" htmlFor="profile-search">
                  Search profiles
                </label>
                <Input
                  variant="search"
                  id="profile-search"
                  type="search"
                  maxLength={200}
                  placeholder="Search profiles"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            {loading && filteredPeople.length === 0 && (
              <div className="flex flex-col" role="status" aria-label="Loading profiles">
                <Skeleton variant="row" className="h-[71px]" />
                <Skeleton variant="row" className="h-[71px]" />
                <Skeleton variant="row" className="h-[71px]" />
              </div>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>{error}</span>
                  <Button variant="outline" onClick={() => void results.refetch()}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {!loading && filteredPeople.length === 0 && !error && (
              <Empty className="min-h-[180px] border-0 px-2 py-6 md:px-2 md:py-6">
                <EmptyHeader>
                  <EmptyTitle>
                    {normalizedSearch ? "No matching profiles" : "No profiles yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {normalizedSearch
                      ? "Try another search."
                      : "Create a profile when you’re ready."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {filteredPeople.map((entry) => (
              <Link
                key={entry.id}
                href={`/profiles/${encodeURIComponent(entry.id)}`}
                className={cn(
                  "flex min-h-[71px] flex-none items-center gap-3 rounded-[3px] p-3 hover:bg-vn-hover",
                  entry.id === currentId && "bg-vn-hover",
                )}
                aria-current={entry.id === currentId ? "page" : undefined}
              >
                <span
                  className="flex size-8 flex-none items-center justify-center rounded-full border border-vn-stroke-strong text-[11px] text-vn-secondary"
                  aria-hidden="true"
                >
                  {entry.displayName
                    .trim()
                    .split(/\s+/)
                    .map((part) => part[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase() || "?"}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1 text-vn-text">
                  <span className="truncate">
                    {entry.displayName || "Untitled profile"}
                    {edits[`person:${entry.id}`]?.dirty ? " ·" : ""}
                  </span>
                  <small className="truncate text-[11px] text-vn-muted">
                    {entry.descriptionPreview || "Profile"}
                  </small>
                </span>
                <span
                  className="w-5 flex-none text-right text-[16px] text-vn-muted"
                  aria-hidden="true"
                >
                  ›
                </span>
              </Link>
            ))}
            {cursor && (
              <Button
                className="self-start"
                variant="ghost"
                disabled={loading}
                onClick={() => void results.fetchNextPage()}
              >
                Load more profiles
              </Button>
            )}
          </aside>
        )}
        <div
          className={cn(
            "vn-content-enter flex min-h-0 min-w-0 flex-col gap-6 [&>*]:shrink-0 [@media(max-width:1100px)]:group-data-[detail=false]/profiles:hidden",
            !editorOnly && "min-[1101px]:overflow-y-auto",
          )}
          data-profile-content
        >
          {person ? (
            <>
              <div
                className={cn(
                  "sticky top-[var(--workspace-header-height)] z-10 flex flex-none flex-col gap-3 bg-vn-page py-3",
                  !editorOnly && "min-[1101px]:top-0",
                )}
              >
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <h2 className="mb-1.5 mt-0 text-[22px] font-normal text-vn-text">
                      {person.displayName || "Untitled profile"}
                    </h2>
                  </div>
                  <span className="text-vn-muted">{edit?.dirty ? "Unsaved" : ""}</span>
                </div>
                <SaveControls entityType="person" entityId={person.id} allowDelete={!editorOnly} />
              </div>
              <p className="m-0 text-vn-muted">
                {person.description || (editorOnly ? "Workspace profile" : "Speaker profile")}
              </p>
              <fieldset className="flex min-w-0 flex-col gap-2.5 border-0 p-0" disabled={locked}>
                <FieldGroup>
                  <Field>
                    <FieldLabel variant="workspace" className="mt-2" htmlFor="profile-name">
                      Display name
                    </FieldLabel>
                    <Input
                      variant="workspace"
                      id="profile-name"
                      name="displayName"
                      required
                      maxLength={200}
                      value={person.displayName}
                      onChange={(event) =>
                        updatePerson({ ...person, displayName: event.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel variant="workspace" className="mt-2" htmlFor="profile-description">
                      Description
                    </FieldLabel>
                    <Textarea
                      variant="workspace"
                      id="profile-description"
                      name="description"
                      rows={5}
                      maxLength={5000}
                      value={person.description}
                      onChange={(event) =>
                        updatePerson({ ...person, description: event.target.value })
                      }
                    />
                  </Field>
                </FieldGroup>
              </fieldset>
              {personRecords[person.id] && session && (
                <ContactDetailsEditor
                  key={`${epoch}:${session.user.id}:${person.id}`}
                  workspaceId={session.workspace.id}
                  personId={person.id}
                />
              )}
              {personRecords[person.id] && session && (
                <ContactResearchPanel
                  key={`research:${epoch}:${session.user.id}:${person.id}`}
                  workspaceId={session.workspace.id}
                  personId={person.id}
                  profileRevision={personRecords[person.id]!.revision}
                />
              )}
              {personRecords[person.id] && <PersonAppearances personId={person.id} />}
            </>
          ) : profileId ? (
            unavailable[`person:${profileId}`] ? (
              <Empty className="min-h-[180px] border-0 px-2 py-6 md:px-2 md:py-6">
                <EmptyHeader>
                  <EmptyTitle>
                    {unavailable[`person:${profileId}`] === "forbidden"
                      ? "Profile unavailable"
                      : "Profile not found"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {unavailable[`person:${profileId}`] === "forbidden"
                      ? "You don’t have access to this profile."
                      : "This profile may have been deleted or the link may be incorrect."}
                  </EmptyDescription>
                </EmptyHeader>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline">
                    <Link href="/profiles" className={cn(!editorOnly && "min-[1101px]:hidden")}>
                      Back to profiles
                    </Link>
                  </Button>
                  <Button variant="ghost" onClick={() => void detail.refetch()}>
                    Retry
                  </Button>
                </div>
              </Empty>
            ) : recordError ? (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-col items-start gap-3">
                  <span>{recordError}</span>
                  <div className="flex gap-2">
                    <Button asChild variant="outline">
                      <Link href="/profiles" className={cn(!editorOnly && "min-[1101px]:hidden")}>
                        Back to profiles
                      </Link>
                    </Button>
                    <Button variant="ghost" onClick={() => void detail.refetch()}>
                      Retry
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex min-h-[180px] flex-col items-start gap-4 text-vn-muted">
                <p className="m-0" role="status" aria-live="polite">
                  Loading profile…
                </p>
                <Skeleton className="h-16 w-full" aria-hidden="true" />
                <Button asChild variant="ghost">
                  <Link href="/profiles" className={cn(!editorOnly && "min-[1101px]:hidden")}>
                    Back to profiles
                  </Link>
                </Button>
              </div>
            )
          ) : (
            <div className="flex min-h-[180px] items-center text-vn-muted">
              <p>Select a profile to view and edit its details.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default People;
