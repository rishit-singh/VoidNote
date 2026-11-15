"use client";

import type { InfiniteData } from "@tanstack/react-query";
import { MutationObserver } from "@tanstack/react-query";

import type {
  CorrectedTurn,
  CorrectionCommand,
  CorrectionResult,
  TranscriptPassage,
} from "@/contracts/transcript-corrections";
import { rpcCall } from "@/lib/api-error";
import type { QueryRuntime } from "@/lib/query-runtime";
import { getQueryRuntime, notifyQueryChange } from "@/lib/query-runtime";

export type TranscriptScope = { workspaceId: string; noteId: string; runId: string };
export type CorrectionUndoPreview = { before: CorrectedTurn[]; after: CorrectedTurn[] };

type Version = Pick<CorrectedTurn, "id" | "revision" | "attributionRevision">;

type TranscriptPage = {
  items: CorrectedTurn[];
  passages?: TranscriptPassage[];
  nextCursor: string | null;
  // Cache-only tombstones prevent older acknowledgements/later pages resurrecting rows.
  correctionRemovals?: Version[];
};

export function transcriptQueryOptions(scope: TranscriptScope) {
  return getQueryRuntime().trpc.transcripts.page.infiniteQueryOptions(scope, {
    enabled: !!scope.workspaceId && !!scope.noteId && !!scope.runId,
    trpc: { abortOnUnmount: true },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

function compareTurns(left: CorrectedTurn, right: CorrectedTurn) {
  return (
    left.sequence - right.sequence ||
    (left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

function atLeast(incoming: Version, current: Version) {
  return (
    incoming.revision >= current.revision &&
    incoming.attributionRevision >= current.attributionRevision
  );
}

function overlapsLineage(left: CorrectedTurn, right: CorrectedTurn) {
  return (
    left.id !== right.id &&
    left.sourceUtteranceId === right.sourceUtteranceId &&
    (left.orderKey.startsWith(right.orderKey) || right.orderKey.startsWith(left.orderKey))
  );
}

/** Page seams may overlap after a split changes a previously issued cursor. */
export function flattenTranscriptPages(pages: readonly TranscriptPage[]): CorrectedTurn[] {
  const removed = new Map<string, Version>();
  const turns = new Map<string, CorrectedTurn>();
  for (const page of pages) {
    for (const version of page.correctionRemovals ?? []) {
      const previous = removed.get(version.id);
      if (!previous || atLeast(version, previous)) {
        removed.set(version.id, version);
      }
    }

    for (const turn of page.items) {
      const previous = turns.get(turn.id);
      if (!previous || atLeast(turn, previous)) {
        turns.set(turn.id, turn);
      }
    }
  }

  return [...turns.values()]
    .filter((turn) => {
      const tombstone = removed.get(turn.id);

      return !tombstone || !atLeast(tombstone, turn);
    })
    .sort(compareTurns);
}

function reconcilePages(pages: TranscriptPage[], result: CorrectionResult): TranscriptPage[] {
  const loaded = flattenTranscriptPages(pages);
  const byId = new Map(loaded.map((turn) => [turn.id, turn]));
  const removals = new Map<string, Version>();
  for (const page of pages) {
    for (const removed of page.correctionRemovals ?? []) {
      const previous = removals.get(removed.id);
      if (!previous || atLeast(removed, previous)) {
        removals.set(removed.id, removed);
      }
    }
  }

  for (const removed of result.current.removed) {
    const current = byId.get(removed.id);
    const previous = removals.get(removed.id);
    if ((!current || atLeast(removed, current)) && (!previous || atLeast(removed, previous))) {
      removals.set(removed.id, removed);
    }
  }

  const next = pages.map((page) => {
    const rest = { ...page };
    delete rest.passages;

    return {
      ...rest,
      items: page.items.filter((turn) => {
        const removed = removals.get(turn.id);

        return !removed || !atLeast(removed, turn);
      }),
      correctionRemovals: [...removals.values()],
    };
  });
  for (const incoming of result.current.items) {
    const current = byId.get(incoming.id);
    const removed = removals.get(incoming.id);
    if ((current && !atLeast(incoming, current)) || (removed && atLeast(removed, incoming))) {
      continue;
    }

    // Fresh pages need not contain ancestor tombstones. Prefixes also cover nested
    // descendants and re-splits that reuse a lineage key under a different ID.
    const relatives = loaded.filter((turn) => overlapsLineage(turn, incoming));
    if (
      relatives.some((turn) => {
        const retirement = removals.get(turn.id);

        return !retirement || !atLeast(retirement, turn);
      })
    ) {
      continue;
    }

    let target = pages.findIndex((page) => page.items.some((turn) => turn.id === incoming.id));
    if (target < 0) {
      target = pages.findIndex((page) =>
        page.items.some((turn) => overlapsLineage(turn, incoming)),
      );
    }

    // No unseen rows outside the loaded range, even when the response covers more IDs.
    if (
      target < 0 &&
      loaded.length &&
      compareTurns(incoming, loaded[0]!) >= 0 &&
      compareTurns(incoming, loaded.at(-1)!) <= 0
    ) {
      target = pages.findIndex((page) =>
        page.items.some((turn) => compareTurns(turn, incoming) >= 0),
      );
    }

    if (target < 0) {
      continue;
    }

    for (const page of next) {
      page.items = page.items.filter((turn) => turn.id !== incoming.id);
    }

    next[target]!.items.push(incoming);
  }

  for (const page of next) {
    page.items.sort(compareTurns);
  }

  return next;
}

export async function reconcileCorrectionResult(
  scope: TranscriptScope,
  result: CorrectionResult,
  runtime: QueryRuntime = getQueryRuntime(),
) {
  const owned = () =>
    runtime === getQueryRuntime() && runtime.identity?.workspaceId === scope.workspaceId;
  if (!owned()) {
    return;
  }

  const { queryClient: cache, trpc } = runtime;
  await Promise.all([
    cache.cancelQueries(trpc.transcripts.page.queryFilter(scope)),
    cache.cancelQueries(trpc.transcripts.page.infiniteQueryFilter(scope)),
  ]);
  if (!owned()) {
    return;
  }

  if (result.current.complete) {
    for (const [key, page] of cache.getQueriesData<TranscriptPage>(
      trpc.transcripts.page.queryFilter(scope),
    )) {
      if (page) {
        cache.setQueryData(key, reconcilePages([page], result)[0]);
      }
    }

    for (const [key, data] of cache.getQueriesData<InfiniteData<TranscriptPage>>(
      trpc.transcripts.page.infiniteQueryFilter(scope),
    )) {
      if (data) {
        cache.setQueryData(key, { ...data, pages: reconcilePages(data.pages, result) });
      }
    }
  }

  void notifyQueryChange("transcript", scope, runtime).catch(() => {});
}

export function submitCorrection(
  scope: TranscriptScope,
  command: CorrectionCommand,
  runtime: QueryRuntime = getQueryRuntime(),
) {
  if (runtime !== getQueryRuntime() || runtime.identity?.workspaceId !== scope.workspaceId) {
    return Promise.reject(new Error("This correction belongs to a previous workspace session."));
  }

  const mutation = new MutationObserver(
    runtime.queryClient,
    runtime.trpc.transcripts.command.mutationOptions({
      retry: false,
      onSuccess: (result) => reconcileCorrectionResult(scope, result, runtime),
    }),
  );

  return rpcCall(() => mutation.mutate({ ...scope, command }));
}

function assigned(
  turn: CorrectedTurn,
  assignment: Extract<CorrectionCommand, { kind: "assign" }>["assignment"],
  personName?: string | null,
): CorrectedTurn {
  return {
    ...turn,
    assignment,
    assignmentSource: "manual",
    personName: assignment.kind === "person" ? (personName ?? null) : null,
    reviewState: "confirmed",
    sampleSuitability:
      assignment.kind === "person"
        ? "candidate"
        : turn.sampleSuitability === "not_evaluated"
          ? "not_evaluated"
          : "invalidated",
  };
}

function splitPreview(
  current: CorrectedTurn,
  command: Extract<CorrectionCommand, { kind: "split" }>,
  personName?: string | null,
): CorrectedTurn[] | null {
  const child = { ...current, parentId: current.id };
  const breaksPair = (offset: number) => {
    const left = current.text.charCodeAt(offset - 1);
    const right = current.text.charCodeAt(offset);

    return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
  };

  if (command.selection) {
    const selected = command.selection;
    const { startOffset, endOffset, startSeconds, endSeconds } = selected;
    if (
      startOffset < 0 ||
      startOffset >= endOffset ||
      endOffset > current.text.length ||
      startSeconds < current.startSeconds ||
      endSeconds > current.endSeconds ||
      startSeconds >= endSeconds ||
      (startOffset === 0
        ? startSeconds !== current.startSeconds
        : startSeconds <= current.startSeconds) ||
      (endOffset === current.text.length
        ? endSeconds !== current.endSeconds
        : endSeconds >= current.endSeconds) ||
      current.orderKey.length >= 254 ||
      breaksPair(startOffset) ||
      breaksPair(endOffset)
    ) {
      return null;
    }

    const children: CorrectedTurn[] = [];
    if (startOffset > 0) {
      children.push({
        ...child,
        id: command.leftId,
        orderKey: `${current.orderKey}00`,
        text: current.text.slice(0, startOffset),
        endSeconds: startSeconds,
        sampleSuitability: "invalidated",
      });
    }

    children.push({
      ...assigned(child, selected.assignment, personName),
      id: selected.selectedId,
      orderKey: `${current.orderKey}01`,
      text: current.text.slice(startOffset, endOffset),
      startSeconds,
      endSeconds,
      sampleSuitability: selected.assignment.kind === "person" ? "candidate" : "invalidated",
    });
    if (endOffset < current.text.length) {
      children.push({
        ...child,
        id: command.rightId,
        orderKey: `${current.orderKey}1`,
        text: current.text.slice(endOffset),
        startSeconds: endSeconds,
        sampleSuitability: "invalidated",
      });
    }

    return children.every((turn) => turn.text.trim()) ? children : null;
  }

  const leftText = current.text.slice(0, command.textOffset).trim();
  const rightText = current.text.slice(command.textOffset).trim();
  if (
    command.splitSeconds <= current.startSeconds ||
    command.splitSeconds >= current.endSeconds ||
    command.textOffset <= 0 ||
    command.textOffset >= current.text.length ||
    current.orderKey.length >= 256 ||
    breaksPair(command.textOffset) ||
    !leftText ||
    !rightText
  ) {
    return null;
  }

  const sampleSuitability =
    current.sampleSuitability === "not_evaluated" ? "not_evaluated" : "invalidated";

  return [
    {
      ...child,
      id: command.leftId,
      orderKey: `${current.orderKey}0`,
      text: leftText,
      endSeconds: command.splitSeconds,
      sampleSuitability,
    },
    {
      ...child,
      id: command.rightId,
      orderKey: `${current.orderKey}1`,
      text: rightText,
      startSeconds: command.splitSeconds,
      sampleSuitability,
    },
  ];
}

/** Pure pending overlay. Dropping it rolls back only this command, never remote data. */
export function optimisticCorrection(
  turns: readonly CorrectedTurn[],
  command: CorrectionCommand,
  { personName, undo }: { personName?: string | null; undo?: CorrectionUndoPreview } = {},
): CorrectedTurn[] {
  if (command.kind === "assign") {
    const targets = new Map(command.targets.map((target) => [target.id, target]));

    return turns.map((turn) =>
      targets.get(turn.id)?.expectedAttributionRevision === turn.attributionRevision
        ? assigned(turn, command.assignment, personName)
        : turn,
    );
  }

  if (command.kind === "undo") {
    const current = new Map(turns.map((turn) => [turn.id, turn]));
    if (
      !undo?.after.length ||
      !undo.before.length ||
      undo.after.some((after) => {
        const turn = current.get(after.id);

        return (
          !turn ||
          turn.revision !== after.revision ||
          turn.attributionRevision !== after.attributionRevision
        );
      })
    ) {
      return [...turns];
    }

    const afterIds = new Set(undo.after.map((turn) => turn.id));
    if (undo.before.some((turn) => current.has(turn.id) && !afterIds.has(turn.id))) {
      return [...turns];
    }

    return [
      ...turns.filter((turn) => !afterIds.has(turn.id)),
      ...undo.before.map((before) => {
        const after = current.get(before.id);

        return after
          ? { ...before, revision: after.revision, attributionRevision: after.attributionRevision }
          : before;
      }),
    ].sort(compareTurns);
  }

  const current = turns.find((turn) => turn.id === command.utteranceId);
  if (!current || current.revision !== command.expectedRevision) {
    return [...turns];
  }

  if (command.kind === "edit") {
    return turns.map((turn) =>
      turn.id === current.id
        ? {
            ...turn,
            text: command.text,
            startSeconds: command.startSeconds,
            endSeconds: command.endSeconds,
            sampleSuitability:
              turn.sampleSuitability === "not_evaluated" ? "not_evaluated" : "invalidated",
          }
        : turn,
    );
  }

  const ids = [command.leftId, command.rightId];
  if (command.selection) {
    ids.push(command.selection.selectedId);
  }

  if (new Set(ids).size !== ids.length || turns.some((turn) => ids.includes(turn.id))) {
    return [...turns];
  }

  const children = splitPreview(current, command, personName);

  return children
    ? [...turns.filter((turn) => turn.id !== current.id), ...children].sort(compareTurns)
    : [...turns];
}
