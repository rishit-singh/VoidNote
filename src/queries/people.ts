"use client";

import type { InfiniteData, QueryKey } from "@tanstack/react-query";
import { MutationObserver } from "@tanstack/react-query";
import { z } from "zod";

import { queryPolicy } from "@/config/query";
import type { PersonListItem, PersonRecord, SavePerson } from "@/contracts/people";
import { toPersonListItem } from "@/contracts/people";
import type { DeleteCommand } from "@/contracts/workspace";
import { rpcCall } from "@/lib/api-error";
import type { QueryRuntime } from "@/lib/query-runtime";
import { getQueryRuntime, notifyQueryChange } from "@/lib/query-runtime";

type PersonPage = { items: PersonListItem[]; nextCursor: string | null };

const listKeyOptions = z.object({
  input: z.object({ q: z.string().optional(), cursor: z.string().nullish() }),
});

export function peopleQueryOptions(workspaceId: string | undefined, search = "") {
  return getQueryRuntime().trpc.people.list.infiniteQueryOptions(
    { workspaceId: workspaceId ?? "", q: search, limit: queryPolicy.peoplePageSize },
    {
      enabled: !!workspaceId,
      trpc: { abortOnUnmount: true },
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
}

/** UUID order is stable on rename. Retain loaded rows and cursor boundaries. */
function reconcilePages(pages: PersonPage[], key: QueryKey, incoming: PersonListItem) {
  const options = listKeyOptions.safeParse(key.at(-1));
  if (!options.success || !pages.length) {
    return pages;
  }

  const currentIndex = pages.findIndex((page) =>
    page.items.some((item) => item.id === incoming.id),
  );
  const current = pages[currentIndex]?.items.find((item) => item.id === incoming.id);
  const person = current && current.revision > incoming.revision ? current : incoming;
  const matches =
    !person.deletedAt &&
    person.displayName.toLowerCase().startsWith((options.data.input.q ?? "").toLowerCase());
  const next = pages.map((page) => ({
    ...page,
    items: page.items.filter((item) => item.id !== person.id),
  }));
  if (!matches) {
    return next;
  }

  let target = currentIndex;
  if (target < 0 && !options.data.input.cursor) {
    target = pages.findIndex((page) => page.items.some((item) => item.id >= person.id));
    if (target < 0 && pages.at(-1)?.nextCursor === null) {
      target = pages.length - 1;
    }
  }

  // An unseen UUID beyond a partial loaded range belongs to a future page.
  const page = next[target];
  if (page) {
    page.items = [...page.items, person].sort((a, b) => a.id.localeCompare(b.id));
  }

  return next;
}

export async function reconcilePersonSnapshot(
  incoming: PersonRecord,
  runtime: QueryRuntime = getQueryRuntime(),
) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== incoming.workspaceId) {
    return;
  }

  const { queryClient: cache, trpc } = runtime;
  const scope = { workspaceId: incoming.workspaceId };
  await Promise.all([
    cache.cancelQueries(trpc.people.get.queryFilter({ ...scope, id: incoming.id })),
    cache.cancelQueries(trpc.people.list.queryFilter(scope)),
    cache.cancelQueries(trpc.people.list.infiniteQueryFilter(scope)),
  ]);
  if (runtime !== getQueryRuntime()) {
    return;
  }

  const detailKey = trpc.people.get.queryKey({ ...scope, id: incoming.id, includeDeleted: false });
  const verifiedKey = trpc.people.get.queryKey({ ...scope, id: incoming.id, includeDeleted: true });
  const person = [
    cache.getQueryData(detailKey),
    cache.getQueryData(verifiedKey),
  ].reduce<PersonRecord>(
    (latest, candidate) => (candidate && candidate.revision > latest.revision ? candidate : latest),
    incoming,
  );
  cache.setQueryData(detailKey, person);
  if (cache.getQueryData(verifiedKey)) {
    cache.setQueryData(verifiedKey, person);
  }

  const item = toPersonListItem(person);
  for (const [key, page] of cache.getQueriesData<PersonPage>(trpc.people.list.queryFilter(scope))) {
    if (page) {
      cache.setQueryData(key, reconcilePages([page], key, item)[0]);
    }
  }

  for (const [key, data] of cache.getQueriesData<InfiniteData<PersonPage>>(
    trpc.people.list.infiniteQueryFilter(scope),
  )) {
    if (data) {
      cache.setQueryData(key, { ...data, pages: reconcilePages(data.pages, key, item) });
    }
  }

  void notifyQueryChange("people", { ...scope, id: person.id }, runtime, true).catch(() => {});

  return person;
}

export function savePerson(
  workspaceId: string,
  command: SavePerson,
  { replaying = false }: { replaying?: boolean } = {},
) {
  const runtime = getQueryRuntime();
  const mutation = new MutationObserver(
    runtime.queryClient,
    runtime.trpc.people.save.mutationOptions({
      retry: false,
      onSuccess: (person) => {
        if (!replaying) {
          return reconcilePersonSnapshot(person, runtime);
        }
      },
    }),
  );

  return rpcCall(() => mutation.mutate({ workspaceId, command })).finally(() => mutation.reset());
}

export function deletePerson(workspaceId: string, command: DeleteCommand) {
  const runtime = getQueryRuntime();
  const mutation = new MutationObserver(
    runtime.queryClient,
    runtime.trpc.people.delete.mutationOptions({
      retry: false,
      onSuccess: (person) => reconcilePersonSnapshot(person, runtime),
    }),
  );

  return rpcCall(() => mutation.mutate({ workspaceId, command })).finally(() => mutation.reset());
}
