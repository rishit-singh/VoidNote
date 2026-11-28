import {
  SummaryAgent as ProductionSummaryAgent,
  type SummaryEnvironment,
} from "../../src/ai/summary/agent";
import {
  summaryAgentName,
  summaryExecutionName,
  summaryWorkflowParamsSchema,
} from "../../src/ai/summary/dispatch";
import { wrapLanguageModel } from "ai";
import { summaryBinding } from "./summary-model.fixture";

export { SummaryWorkflow } from "../../src/ai/summary/workflow";

// Keep production admission, policy, submission hooks, and Workflow untouched.
// The real Workers AI adapter consumes a deterministic local binding response.
export class SummaryAgent extends ProductionSummaryAgent {
  private fixtureRequest: unknown;

  override getAIBinding(): Ai {
    return this.observeSummaryAIBinding(summaryBinding(() => this.fixtureRequest));
  }

  override resolveModel(model?: ThinkModel) {
    if (model && typeof model !== "string") return model;
    const resolved = super.resolveModel(model);
    if (typeof resolved === "string") throw new Error("Unresolved fixture model");
    return wrapLanguageModel({
      model: resolved,
      middleware: {
        wrapStream: async ({ params, doStream }) => {
          this.fixtureRequest = {
            tools: params.tools,
            toolChoice: params.toolChoice,
            prompt: params.prompt,
          };
          return doStream();
        },
      },
    });
  }

  async inspectFixture(): Promise<string> {
    return JSON.stringify({
      name: this.name,
      state: this.state,
      submissions: await this.listSubmissions(),
    });
  }

  // Explicitly simulate the production recovery hook, not a DO eviction or
  // Think's recovery engine. The preceding inference runs through the real SDK.
  async recoverFixture(): Promise<string> {
    return JSON.stringify(await this.onChatRecovery());
  }
}

type FixtureEnvironment = Omit<SummaryEnvironment, "SUMMARY_AGENT"> & {
  SUMMARY_AGENT: DurableObjectNamespace<SummaryAgent>;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const params = summaryWorkflowParamsSchema.parse({
      workspaceId: url.searchParams.get("workspaceId"),
      jobId: url.searchParams.get("jobId"),
    });
    const workflowId = summaryExecutionName(params);
    // Match the Next adapter: the first public async RPC must initialize the
    // Agent's name without getAgentByName() or a prior identity-setting call.
    const agent = env.SUMMARY_AGENT.get(env.SUMMARY_AGENT.idFromName(summaryAgentName(params)));
    try {
      if (url.pathname === "/start") {
        return Response.json({ workflowId: await agent.startSummary(params) });
      }
      if (url.pathname === "/cancel") {
        await agent.cancelSummary(params);
        return Response.json({ cancelled: true });
      }
      if (url.pathname === "/agent") {
        return new Response(await agent.inspectFixture(), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/recover") {
        return new Response(await agent.recoverFixture(), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/reconcile-usage") {
        await agent.reconcileSummaryUsage();
        return Response.json({ reconciled: true });
      }
      if (url.pathname === "/inspect") {
        const instance = await env.SUMMARY_WORKFLOW.get(workflowId);
        const inspection: unknown = JSON.parse(await agent.inspectFixture());
        return Response.json({
          workflow: await instance.status(),
          agent: inspection,
        });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<FixtureEnvironment>;
import type { ThinkModel } from "@cloudflare/think";
