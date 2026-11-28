import { and, eq } from "drizzle-orm";

import type { AssistantToolResult } from "../../contracts/assistant";
import type { AssistantProfileMutation } from "../../contracts/assistant/lineage";
import { type Principal, WorkspaceError } from "../../contracts/workspace";
import { assistantProfileChanges } from "../assistant-profiles-schema";
import { fingerprint, type ProfileSupersession, type Transaction } from "./shared";

type ProfileTransition = {
  beforePersonRevision: number;
  beforeContactRevision: number;
  afterPersonRevision: number;
  afterContactRevision: number;
};

/** A completion may replace a profile source only with an exact same-turn,
 * acknowledged patch receipt whose contiguous revision chain ends at current state.
 */
export async function verifiedProfileSupersessions(
  tx: Transaction,
  principal: Principal,
  workspaceId: string,
  turnId: string,
  mutations: AssistantProfileMutation[],
  tools: AssistantToolResult[],
): Promise<Map<string, ProfileSupersession>> {
  const transitions = new Map<string, ProfileTransition[]>();

  const seenOperations = new Set<string>();

  for (const mutation of mutations) {
    if (seenOperations.has(mutation.operationId)) {
      throw new WorkspaceError("conflict", "Profile mutation proof repeats an operation.");
    }

    seenOperations.add(mutation.operationId);

    if (mutation.name !== "contacts_update") {
      continue;
    }

    const tool = tools.find((entry) => entry.id === mutation.operationId);

    if (tool?.status !== "succeeded" || tool.name !== mutation.name) {
      throw new WorkspaceError("conflict", "Profile supersession requires an acknowledged update.");
    }

    const input = { ...mutation.input, operationId: mutation.operationId };

    const expectedFingerprint = fingerprint({
      actorId: principal.id,
      workspaceId,
      kind: "assistant-profile-patch",
      version: 1,
      executor: "agent",
      input,
      turnId,
    });

    const [change] = await tx
      .select()
      .from(assistantProfileChanges)
      .where(
        and(
          eq(assistantProfileChanges.workspaceId, workspaceId),
          eq(assistantProfileChanges.operationId, mutation.operationId),
        ),
      )
      .limit(1);

    if (
      !change ||
      change.actorId !== principal.id ||
      change.executor !== "agent" ||
      change.kind !== "patch" ||
      change.turnId !== turnId ||
      change.personId !== mutation.input.personId ||
      change.expectedPersonRevision !== mutation.input.expectedPersonRevision ||
      change.expectedContactRevision !== mutation.input.expectedContactRevision ||
      change.fingerprint !== expectedFingerprint ||
      !change.sources.every((dependency) =>
        tool.sources.some(
          (source) =>
            source.kind === dependency.kind &&
            source.id === dependency.id &&
            source.revision === dependency.revision &&
            source.contactRevision === dependency.contactRevision,
        ),
      ) ||
      !tool.sources.some(
        (source) =>
          source.kind === "person" &&
          source.id === change.personId &&
          source.revision === change.personRevision &&
          source.contactRevision === change.contactRevision,
      )
    ) {
      throw new WorkspaceError("conflict", "Profile update receipt does not match this turn.");
    }

    if (change.expectedContactRevision === change.contactRevision) {
      continue;
    }

    const group = transitions.get(change.personId) ?? [];

    group.push({
      beforePersonRevision: change.expectedPersonRevision,
      beforeContactRevision: change.expectedContactRevision,
      afterPersonRevision: change.personRevision,
      afterContactRevision: change.contactRevision,
    });
    transitions.set(change.personId, group);
  }

  const supersessions = new Map<string, ProfileSupersession>();

  for (const [personId, chain] of transitions) {
    chain.sort(
      (left, right) =>
        left.beforeContactRevision - right.beforeContactRevision ||
        left.beforePersonRevision - right.beforePersonRevision,
    );

    if (
      chain.some(
        (entry, index) =>
          index > 0 &&
          (chain[index - 1]!.afterPersonRevision !== entry.beforePersonRevision ||
            chain[index - 1]!.afterContactRevision !== entry.beforeContactRevision),
      )
    ) {
      throw new WorkspaceError("conflict", "Profile changed between acknowledged updates.");
    }

    const last = chain.at(-1)!;

    supersessions.set(personId, {
      sourceRevisions: new Set(
        chain.flatMap((entry) => [
          `${entry.beforePersonRevision}:${entry.beforeContactRevision}`,
          `${entry.afterPersonRevision}:${entry.afterContactRevision}`,
        ]),
      ),
      personRevision: last.afterPersonRevision,
      contactRevision: last.afterContactRevision,
    });
  }

  return supersessions;
}
