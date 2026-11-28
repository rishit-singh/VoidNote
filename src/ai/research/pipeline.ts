import { WorkspaceError } from "../../contracts/workspace";
import { researchExtractionFailureCode, validateResearchExtraction } from "./extraction";
import type {
  ResearchAdmissionPort,
  ResearchDiscoveryProvider,
  ResearchExecutionKey,
  ResearchExecutionStore,
  ResearchExtractionProvider,
  ResearchServiceBudgetPort,
  SourceResearchProvider,
} from "./ports";

export type ResearchPipelinePorts = {
  store: ResearchExecutionStore;
  sources: SourceResearchProvider;
  discovery?: ResearchDiscoveryProvider | undefined;
  serviceBudget?: ResearchServiceBudgetPort | undefined;
  extraction: ResearchExtractionProvider;
  admission: ResearchAdmissionPort;
  enabled: () => boolean;
};

/** Postgres checkpoints survive both Workflow restart and a new retry generation.
 * No paid operation is retried after its durable 'started' fence. */
export async function runResearchItem(
  key: ResearchExecutionKey,
  ports: ResearchPipelinePorts,
): Promise<void> {
  let execution = await ports.store.load(key);

  if (!execution || !["queued", "running"].includes(execution.status)) {
    return;
  }

  if (!ports.enabled()) {
    await ports.store.finish(key, "needs-input", "Research inference is disabled.");

    return;
  }

  if (Date.parse(execution.deadline) <= Date.now()) {
    await ports.store.finish(key, "failed", "The research deadline elapsed.");

    return;
  }

  if (
    execution.request.sourceUrls.length === 0 &&
    execution.policy.sourceProvider !== "firecrawl"
  ) {
    await ports.store.finish(
      key,
      "needs-input",
      "Supply public source URLs for this person. Web discovery is not configured.",
    );

    return;
  }

  if (!(await ports.store.start(key))) {
    return;
  }

  let sourceRetrievalFailed = false;

  for (const url of execution.request.sourceUrls) {
    execution = await ports.store.load(key);

    if (!execution || execution.status !== "running" || !ports.enabled()) {
      return;
    }

    if (execution.sources.some((source) => source.requestedUrl === url)) {
      continue;
    }

    let source;

    try {
      source = await ports.sources.retrieve(
        url,
        execution.policy,
        AbortSignal.timeout(execution.policy.sourceTimeoutMs),
      );
    } catch {
      // A failed optional URL must not discard usable independent evidence.
      sourceRetrievalFailed = true;
      continue;
    }

    // A failed durable checkpoint is retryable infrastructure work, not an
    // unusable URL. Do not silently discard evidence after retrieval succeeded.
    if (!(await ports.store.saveSource(key, source))) {
      return;
    }
  }

  const shouldDiscoverSources =
    execution.policy.sourceProvider === "firecrawl" &&
    (execution.request.sourceUrls.length === 0 || execution.request.discoverSources === true);

  if (shouldDiscoverSources) {
    execution = await ports.store.load(key);

    if (!execution || execution.status !== "running") {
      return;
    }

    if (execution.discovery.state === "started") {
      await ports.store.finish(
        key,
        "needs-input",
        "Source discovery has an uncertain outcome. No paid search replay was issued.",
      );

      return;
    }

    if (execution.discovery.state === "completed") {
      if (execution.discovery.creditsUsed !== null && !execution.discovery.settled) {
        if (!ports.serviceBudget) {
          throw new Error("Research service-budget settlement port is unavailable.");
        }

        await ports.serviceBudget.settle({
          workspaceId: key.workspaceId,
          operationId: execution.discovery.operationId,
          actualUnits: execution.discovery.creditsUsed,
        });
        await ports.store.markDiscoverySettled(key);
      }
    } else {
      if (!ports.discovery) {
        await ports.store.finish(key, "needs-input", "Configured source discovery is unavailable.");

        return;
      }

      if (
        !ports.serviceBudget ||
        !execution.policy.serviceBudgetId ||
        !execution.policy.searchUnitBound
      ) {
        await ports.store.finish(
          key,
          "needs-input",
          "Source discovery needs a configured service-unit allowance.",
        );

        return;
      }

      const serviceBudget = ports.serviceBudget;

      const budgetId = execution.policy.serviceBudgetId;

      const searchUnitBound = execution.policy.searchUnitBound;

      if (execution.discovery.state === "pending") {
        if (!(await ports.store.claimDiscovery(key))) {
          return;
        }

        execution = await ports.store.load(key);

        if (!execution || execution.status !== "running") {
          return;
        }
      }

      if (execution.discovery.state === "reserving") {
        let reservation;

        try {
          reservation = await serviceBudget.reserve({
            workspaceId: key.workspaceId,
            budgetId,
            operationId: execution.discovery.operationId,
            maximumUnits: searchUnitBound,
          });
        } catch (error) {
          // No network submission is allowed before state becomes `started`.
          // An unknown error may mean the reservation committed: reset to pending
          // and throw so durable retry uses the same ID to recover its hold.
          const reset = await ports.store.resetDiscoveryReservation(key);

          if (!(error instanceof WorkspaceError)) {
            throw error;
          }

          if (reset) {
            await ports.store.finish(key, "needs-input", error.message);
          }

          return;
        }

        if (reservation.status === "settled") {
          await ports.store.resetDiscoveryReservation(key);
          await ports.store.finish(
            key,
            "needs-input",
            "This discovery operation already has a settled service receipt and cannot be submitted again.",
          );

          return;
        }

        if (!(await ports.store.markDiscoveryReserved(key))) {
          return;
        }

        execution = await ports.store.load(key);

        if (!execution || execution.status !== "running") {
          return;
        }
      }

      if (execution.discovery.state === "reserved") {
        if (
          !ports.enabled() ||
          Date.parse(execution.deadline) <= Date.now() ||
          !(await ports.store.claimDiscoverySubmission(key))
        ) {
          return;
        }

        execution = await ports.store.load(key);

        if (!execution || execution.status !== "running") {
          return;
        }

        let discovery;

        try {
          discovery = await ports.discovery.discover(
            { person: execution.person, facts: execution.request.requestedFacts },
            execution.policy,
            AbortSignal.timeout(execution.policy.discoveryTimeoutMs),
          );

          if (discovery.creditsUsed !== null && discovery.creditsUsed > searchUnitBound) {
            throw new Error("Provider usage exceeded the reserved bound.");
          }
        } catch {
          await ports.store.finish(
            key,
            "needs-input",
            "Source discovery was interrupted or rejected. Its outcome is uncertain; no paid replay was issued.",
          );

          return;
        }

        const saved = await ports.store.saveDiscoveredSources(
          key,
          discovery.sources,
          discovery.creditsUsed,
        );

        if (discovery.creditsUsed !== null) {
          await serviceBudget.settle({
            workspaceId: key.workspaceId,
            operationId: execution.discovery.operationId,
            actualUnits: discovery.creditsUsed,
          });

          if (saved) {
            await ports.store.markDiscoverySettled(key);
          }
        }

        if (!saved) {
          return;
        }

        execution = await ports.store.load(key);

        if (!execution || execution.status !== "running") {
          return;
        }
      }
    }
  }

  execution = await ports.store.load(key);

  if (!execution || execution.status !== "running") {
    return;
  }

  if (execution.sources.length === 0) {
    await ports.store.finish(
      key,
      "needs-input",
      "No full-page source content was available to support research.",
    );

    return;
  }

  let lastFailureCode: string | null = null;

  for (const requested of execution.request.requestedFacts) {
    execution = await ports.store.load(key);

    if (!execution || execution.status !== "running") {
      return;
    }

    const checkpoint = execution.facts.find((fact) => fact.key === requested.key);

    if (!checkpoint) {
      throw new Error("Research fact checkpoint is missing.");
    }

    if (checkpoint.state === "completed") {
      if (checkpoint.usage && !checkpoint.settled) {
        // Settlement failure cannot rerun extraction; authoritative usage was
        // checkpointed with the finding before this external ledger operation.
        await ports.admission.settle(checkpoint.operationId, checkpoint.usage);
        await ports.store.markSettled(key, requested.key);
      }

      continue;
    }

    if (checkpoint.state === "rejected") {
      lastFailureCode = checkpoint.failureCode ?? "validation_error";

      if (checkpoint.usage && !checkpoint.settled) {
        await ports.admission.settle(checkpoint.operationId, checkpoint.usage);
        await ports.store.markSettled(key, requested.key);
      }

      continue;
    }

    if (checkpoint.state === "started") {
      await ports.store.finish(
        key,
        "needs-input",
        "An extraction outcome is uncertain. Its inference hold is retained; no paid replay was issued.",
      );

      return;
    }

    if (!ports.enabled() || Date.parse(execution.deadline) <= Date.now()) {
      await ports.store.finish(key, "needs-input", "Research stopped before the next extraction.");

      return;
    }

    const input = {
      operationId: checkpoint.operationId,
      person: execution.person,
      fact: requested,
      sources: execution.sources,
      policy: execution.policy,
    };

    // Claim before admission. A crash during admission is conservatively uncertain,
    // even if no provider request was made.
    if (!(await ports.store.claimFact(key, requested.key))) {
      return;
    }

    try {
      await ports.admission.admit(input);
    } catch {
      await ports.store.finish(
        key,
        "needs-input",
        "Inference admission is unavailable or already claimed. No new model request was sent.",
      );

      return;
    }

    // Re-check authority after budget I/O and immediately before provider I/O.
    const current = await ports.store.load(key);

    if (!current || current.status !== "running" || !ports.enabled()) {
      return;
    }

    let result: Awaited<ReturnType<ResearchExtractionProvider["extract"]>>;

    try {
      result = await ports.extraction.extract(
        input,
        AbortSignal.timeout(execution.policy.extractionTimeoutMs),
      );
    } catch {
      await ports.store.finish(
        key,
        "needs-input",
        "Extraction was interrupted and its outcome is uncertain. No automatic paid retry was issued.",
      );

      return;
    }

    let finding;

    try {
      finding = validateResearchExtraction(input, result.output);
    } catch (error) {
      const failureCode = researchExtractionFailureCode(error);

      lastFailureCode = failureCode;

      const saved = await ports.store.saveRejectedFailure(
        key,
        requested.key,
        failureCode,
        result.usage,
      );

      if (saved) {
        if (result.usage) {
          await ports.admission.settle(checkpoint.operationId, result.usage);
          await ports.store.markSettled(key, requested.key);
        }
      } else if (result.usage) {
        // Cancellation, revoked membership, or changed source authority fences
        // checkpoint publication, but cannot erase known provider accounting.
        await ports.admission.settle(checkpoint.operationId, result.usage);
      }

      if (!saved) {
        return;
      }

      continue;
    }

    if (!(await ports.store.saveFinding(key, requested.key, finding, result.usage))) {
      // Cancellation/stale identity fences publication, not legitimate accounting.
      if (result.usage) {
        await ports.admission.settle(checkpoint.operationId, result.usage);
      }

      return;
    }

    if (result.usage) {
      await ports.admission.settle(checkpoint.operationId, result.usage);
      await ports.store.markSettled(key, requested.key);
    }
  }

  execution = await ports.store.load(key);

  if (!execution || execution.status !== "running") {
    return;
  }

  const completedFacts = execution.facts.filter((fact) => fact.state === "completed");

  if (completedFacts.length === 0) {
    await ports.store.finish(
      key,
      "needs-input",
      sourceRetrievalFailed
        ? "No usable source evidence or validated findings were available."
        : lastFailureCode
          ? `The extraction failed validation (${lastFailureCode}). No finding was published.`
          : "No validated findings were available.",
    );

    return;
  }

  const allFactsCompleted = execution.facts.every((fact) => fact.state === "completed");

  await ports.store.finish(key, allFactsCompleted ? "completed" : "partial", null);
}
