import type { ThinkWorkflowStep } from "@cloudflare/think/workflows";
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent, DefaultProgress } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";

import { researchRunPolicySchema } from "../../../config/research-runs";
import { researchAgentScopeSchema } from "../../../contracts/research/agent";
import type { ResearchAgentRunKey } from "../../../contracts/research/execution";
import {
  researchWorkflowCandidateFeedback,
  researchWorkflowCandidateSchema,
  researchWorkflowPublicationResultSchema,
} from "../../../contracts/research/workflow";
import type { ResearchWorkflowAgent, ResearchWorkflowAgentEnvironment } from "./agent";
import { researchWorkflowCorrectionInstructions } from "./instructions";

const MAX_FEEDBACK_CHARACTERS = 1000;

export class ResearchInvestigationWorkflow extends ThinkWorkflow<
  ResearchWorkflowAgent,
  ResearchAgentRunKey,
  DefaultProgress,
  ResearchWorkflowAgentEnvironment
> {
  override async run(event: AgentWorkflowEvent<ResearchAgentRunKey>, step: ThinkWorkflowStep) {
    const key = event.payload;

    if (event.instanceId !== key.runId) {
      throw new Error("Research Workflow identity does not match the run.");
    }

    const execution = await step.do("prepare-research-run", async () => {
      const authorized = (await this.agent.prepareResearchRun(key)) as unknown;

      const executionSchema = researchRunPolicySchema;

      const scope = researchAgentScopeSchema;

      if (
        typeof authorized !== "object" ||
        authorized === null ||
        !("scope" in authorized) ||
        !("policy" in authorized)
      ) {
        throw new Error("Research Agent returned an invalid execution DTO.");
      }

      return {
        scope: scope.parse(authorized.scope),
        policy: executionSchema.parse(authorized.policy),
      };
    });

    const initialPrompt = [
      "Investigate the authorized assignment and return a complete structured report candidate.",
      `Assignment: ${execution.scope.question}`,
      `Admitted questions: ${JSON.stringify(execution.scope.questions)}`,
      `Timeframe: ${JSON.stringify(execution.scope.timeframe)}`,
    ].join("\n");

    let candidate = researchWorkflowCandidateSchema.parse(
      await step.prompt("investigate", {
        prompt: initialPrompt,
        output: researchWorkflowCandidateSchema,
        timeout: `${Math.ceil(execution.policy.deadlineMs / 1000)} seconds`,
        cancelOnTimeout: true,
      }),
    );

    let feedback = researchWorkflowCandidateFeedback(execution.scope, candidate).join("\n");

    if (!feedback) {
      const publication = await step.do("publish-initial-candidate", async () => {
        const result = (await this.agent.publishResearchCandidate(candidate)) as unknown;

        return researchWorkflowPublicationResultSchema.parse(result);
      });

      if (publication.published) {
        return { published: true };
      }

      feedback = publication.feedback ?? "The application rejected the report candidate.";
    }

    feedback = feedback.slice(0, MAX_FEEDBACK_CHARACTERS);
    await this.agent.setCorrectionMode();

    const corrected = await step.prompt("correct-candidate", {
      key: "correction-1",
      prompt: researchWorkflowCorrectionInstructions(initialPrompt, feedback),
      output: researchWorkflowCandidateSchema,
      timeout: `${Math.ceil(execution.policy.deadlineMs / 1000)} seconds`,
      cancelOnTimeout: true,
    });

    candidate = researchWorkflowCandidateSchema.parse(corrected);
    feedback = researchWorkflowCandidateFeedback(execution.scope, candidate).join("\n");

    if (feedback) {
      throw new NonRetryableError(
        `The corrected report still does not cover the admitted questions: ${feedback.slice(0, MAX_FEEDBACK_CHARACTERS)}`,
      );
    }

    const publication = await step.do("publish-corrected-candidate", async () => {
      const result = (await this.agent.publishResearchCandidate(candidate)) as unknown;

      return researchWorkflowPublicationResultSchema.parse(result);
    });

    if (!publication.published) {
      throw new NonRetryableError(
        `The corrected report was rejected: ${(publication.feedback ?? "application validation failed").slice(0, MAX_FEEDBACK_CHARACTERS)}`,
      );
    }

    return { published: true };
  }
}
