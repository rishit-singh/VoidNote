import { researchPolicySchema } from "../../src/config/research";
import {
  createResearchRuntime,
  createWorkersResearchExtraction,
} from "../../src/ai/research/worker";
import { parseResearchHttpResponse } from "../../src/ai/research/worker-transport";
import { researchWorkflowId } from "../../src/ai/research/identity";

const fixture = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/http") {
      try {
        const response = parseResearchHttpResponse(
          new Uint8Array(await request.arrayBuffer()),
          1000,
        );
        return Response.json({ status: response.status, text: await response.text() });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "invalid" },
          { status: 400 },
        );
      }
    }
    if (url.pathname === "/identity") {
      const workspaceId = crypto.randomUUID();
      const batchId = crypto.randomUUID();
      const personId = crypto.randomUUID();
      const key = { workspaceId, batchId, personId, generation: 1 };
      return Response.json({
        first: researchWorkflowId(key),
        replay: researchWorkflowId(key),
        otherScope: researchWorkflowId({ ...key, workspaceId: crypto.randomUUID() }),
        retry: researchWorkflowId({ ...key, generation: 2 }),
      });
    }
    let calls = 0;
    const models: string[] = [];
    const mode = url.searchParams.get("mode");
    // Only the raw binding is replaced. The installed provider and AI SDK run.
    const binding = {
      run(model: string) {
        calls++;
        models.push(model);
        if (mode === "failure") return Promise.reject(new Error("Model request failed"));
        return Promise.resolve({
          response: mode === "invalid" ? "not JSON" : JSON.stringify({ answer: "fixture-only" }),
          ...(mode === "missing"
            ? {}
            : {
                usage:
                  mode === "partial"
                    ? { prompt_tokens: 13 }
                    : { prompt_tokens: 13, completion_tokens: 7 },
              }),
        });
      },
    } as unknown as Ai;
    const policy = researchPolicySchema.parse({
      version: "research-v1",
      promptVersion: "research-extract-v1",
      provider: "workers-ai",
      model: "@cf/test/extraction",
      budgetId: crypto.randomUUID(),
      rateVersionId: crypto.randomUUID(),
    });
    const input = {
      operationId: crypto.randomUUID(),
      person: {
        id: crypto.randomUUID(),
        revision: 1,
        displayName: "Ada Lovelace",
        description: "",
        professional: { revision: 0, organization: "", role: "", links: [] },
      },
      fact: { key: "role", question: "What role is supported?" },
      sources: [],
      policy,
    };
    let currentFlag =
      url.pathname === "/guard" || url.pathname === "/admission-guard"
        ? (url.searchParams.get("flag") ?? undefined)
        : "true";
    if (url.pathname === "/admission-guard") {
      let databaseTouches = 0;
      const env = {
        RESEARCH_ENABLED: currentFlag,
        AI: binding,
        get HYPERDRIVE(): never {
          databaseTouches++;
          throw new Error("Disabled admission must not reach the database.");
        },
      };
      const runtime = createResearchRuntime(env as unknown as Cloudflare.Env, {
        workspaceId: crypto.randomUUID(),
        batchId: crypto.randomUUID(),
        personId: input.person.id,
        generation: 1,
      });
      if (mode === "disable-after-construction") env.RESEARCH_ENABLED = "false";
      try {
        await runtime.admission.admit(input);
        return Response.json({ failed: false, calls, databaseTouches });
      } catch (error) {
        return Response.json({
          failed: true,
          calls,
          databaseTouches,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    const enabled = () => {
      const result = currentFlag === "true";
      if (mode === "disable-before-io") currentFlag = "false";
      return result;
    };
    const extraction =
      mode === "default-disabled"
        ? createWorkersResearchExtraction(binding)
        : createWorkersResearchExtraction(binding, enabled);
    try {
      const result = await extraction.extract(input, AbortSignal.timeout(1000));
      if (mode === "disable-between-calls") {
        currentFlag = "false";
        await extraction.extract(input, AbortSignal.timeout(1000));
      }
      if (mode === "pinned-model") return Response.json({ ...result, calls, models });
      return Response.json({ ...result, calls });
    } catch {
      return Response.json({ failed: true, calls });
    }
  },
};

export default fixture;
