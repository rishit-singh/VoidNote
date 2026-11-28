import type { ResearchRunDetail, ResearchRunExecutionKey } from "../../contracts/research/runs";
import { WorkspaceError } from "../../contracts/workspace";
import type { Database } from "../repository";
import { createResearchAgentOperationsRepository } from "./agent-operations";
import { createResearchRunsRepository } from "./runs";

/**
 * Findings, report, activity event and the publication receipt share one commit.
 * Retrying this local transaction is safe; it never calls an external provider.
 */
export async function publishResearchAgentReport(
  db: Database,
  key: ResearchRunExecutionKey & { operationId: string },
  report: NonNullable<ResearchRunDetail["report"]>,
) {
  return db.transaction(async (tx) => {
    const operations = createResearchAgentOperationsRepository(tx);

    const receipt = await operations.prepare(key, {
      kind: "tool",
      payload: { tool: "publish_report", report },
    });

    if (!receipt) {
      throw new WorkspaceError("conflict", "Publication could not be prepared.");
    }

    if (receipt.state === "completed") {
      return { published: true as const, receiptId: key.operationId };
    }

    const claimed = await operations.claim(key);

    if (claimed.status !== "claimed") {
      throw new WorkspaceError("conflict", "Publication has an unresolved operation receipt.");
    }

    const runs = createResearchRunsRepository(tx);

    for (const finding of report.findings) {
      if (!(await runs.saveQuestionFinding(key, finding.questionId, finding))) {
        throw new WorkspaceError("conflict", "The research question cannot be published.");
      }
    }

    if (!(await runs.finish(key, { status: "completed", report }))) {
      throw new WorkspaceError("conflict", "The research run cannot be published.");
    }

    const result = { published: true as const, receiptId: key.operationId };

    await operations.complete(key, { result });

    return result;
  });
}
