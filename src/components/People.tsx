"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getQueryRuntime } from "@/lib/query-runtime";
import { ApiError, asApiError } from "@/lib/api-error";
import { usePeopleQuery } from "@/hooks/use-workspace-queries";
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

export function People({ profileId }: { profileId?: string }) {
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
  const results = usePeopleQuery(useDebouncedValue(search.trim()));
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
      className="vn-page vn-profiles"
      data-detail={!!profileId}
      aria-labelledby="profiles-title"
    >
      <div className="vn-page-heading">
        <div className="flex items-center gap-4">
          {profileId && (
            <Link href="/profiles" className="vn-back-link">
              ← Profiles
            </Link>
          )}
          <h1 id="profiles-title">Profiles</h1>
        </div>
        <Button
          variant="outline"
          aria-label="New profile"
          disabled={!ready}
          onClick={createProfile}
        >
          + New
        </Button>
      </div>
      <div className="vn-search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <label className="sr-only" htmlFor="profile-search">
          Search profiles
        </label>
        <Input
          id="profile-search"
          type="search"
          maxLength={200}
          placeholder="Search profiles"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="vn-profile-browser">
        <aside className="vn-profile-list" aria-label="Profiles">
          {loading && filteredPeople.length === 0 && (
            <div className="vn-profile-loading" role="status" aria-label="Loading profiles">
              <Skeleton />
              <Skeleton />
              <Skeleton />
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
            <Empty className="vn-profile-empty">
              <EmptyHeader>
                <EmptyTitle>
                  {normalizedSearch ? "No matching profiles" : "No profiles yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {normalizedSearch ? "Try another search." : "Create a profile when you’re ready."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {filteredPeople.map((entry) => (
            <Link
              key={entry.id}
              href={`/profiles/${encodeURIComponent(entry.id)}`}
              className={cn("vn-profile-row", entry.id === currentId && "is-active")}
              aria-current={entry.id === currentId ? "page" : undefined}
            >
              <span className="vn-avatar" aria-hidden="true">
                {entry.displayName
                  .trim()
                  .split(/\s+/)
                  .map((part) => part[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase() || "?"}
              </span>
              <span className="vn-profile-label">
                <span>
                  {entry.displayName || "Untitled profile"}
                  {edits[`person:${entry.id}`]?.dirty ? " ·" : ""}
                </span>
                <small>{entry.descriptionPreview || "Profile"}</small>
              </span>
              <span className="vn-trailing" aria-hidden="true">
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
        <div className="vn-profile-detail">
          {person ? (
            <>
              <div className="vn-profile-detail-heading">
                <div>
                  <h2>{person.displayName || "Untitled profile"}</h2>
                  <p>{person.description || "Speaker profile"}</p>
                </div>
                <span className="vn-muted">{edit?.dirty ? "Unsaved" : ""}</span>
              </div>
              <fieldset className="vn-form-fields" disabled={locked}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="profile-name">Display name</FieldLabel>
                    <Input
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
                    <FieldLabel htmlFor="profile-description">Description</FieldLabel>
                    <Textarea
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
              <p className="vn-muted">
                Renaming keeps this profile’s identity across every assigned recording.
              </p>
              <SaveControls entityType="person" entityId={person.id} />
              {personRecords[person.id] && <PersonAppearances personId={person.id} />}
            </>
          ) : profileId ? (
            unavailable[`person:${profileId}`] ? (
              <Empty className="vn-unavailable-profile">
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
                    <Link href="/profiles">Back to profiles</Link>
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
                      <Link href="/profiles">Back to profiles</Link>
                    </Button>
                    <Button variant="ghost" onClick={() => void detail.refetch()}>
                      Retry
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <div className="vn-profile-prompt" role="status">
                <Skeleton className="h-16 w-full" />
                <p>Loading profile…</p>
                <Button asChild variant="ghost">
                  <Link href="/profiles">Back to profiles</Link>
                </Button>
              </div>
            )
          ) : (
            <div className="vn-profile-prompt">
              <p>Select a profile to view and edit its details.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default People;
