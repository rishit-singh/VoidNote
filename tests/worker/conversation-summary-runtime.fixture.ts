import {
  readConversationSummaryPolicy,
  requireConversationSummaryPolicy,
} from "../../src/config/conversation-summary";
import type { ConversationSummaryExecution } from "../../src/contracts/conversation-summaries";
import {
  buildConversationSummaryPrompt,
  measureConversationSummaryPrompt,
} from "../../src/contracts/conversation-summaries";
import { dispatchConversationSummary } from "../../src/ai/conversation-summaries/dispatch";
import {
  conversationSummaryKeySchema,
  conversationSummaryWorkflowId,
  type ConversationSummaryKey,
} from "../../src/ai/conversation-summaries/identity";
import { createConversationSummaryModel } from "../../src/ai/conversation-summaries/model";
import type { ConversationSummaryRuntime } from "../../src/ai/conversation-summaries/ports";
import { conversationSummaryPrompt } from "../../src/ai/conversation-summaries/prompt";
import {
  createConversationSummaryRuntime,
  type ConversationSummaryEnvironment,
} from "../../src/ai/conversation-summaries/runtime";
import { ConversationSummaryWorkflow as ApplicationWorkflow } from "../../src/ai/conversation-summaries/workflow";

async function invoke<T>(operation: string, args: unknown[] = []): Promise<T> {
  const response = await fetch(`https://conversation-summary.test/${operation}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    const error = new Error("Fixture operation unavailable.");
    const code = response.headers.get("x-fixture-error-code");
    if (code) Object.assign(error, { code });
    throw error;
  }

  return response.json<T>();
}

function runtime(env: ConversationSummaryEnvironment): ConversationSummaryRuntime {
  const config = { ...env };
  const requireEnabled: ConversationSummaryRuntime["requireEnabled"] = (policy) =>
    requireConversationSummaryPolicy(config, policy);
  const binding = {
    run: (model: string, input: unknown) => invoke("model", [model, input]),
  } as unknown as Ai;

  return {
    load: (key) => invoke("load", [key]),
    begin: (key) => invoke("begin", [key]),
    publish: (key, text) => invoke("publish", [key, text]),
    fail: (key, error) => invoke("fail", [key, error]),
    requireEnabled,
    generate: createConversationSummaryModel(binding, requireEnabled),
    async reserve(execution, inputTokenBound) {
      requireEnabled(execution.policy);
      const disable = await invoke<boolean>("reserve", [
        execution.jobId,
        execution.policy,
        inputTokenBound,
      ]);
      if (disable) config.CONVERSATION_SUMMARY_ENABLED = "false";
    },
    settle: (key, usage) => invoke("settle", [key, usage]),
  };
}

export class ConversationSummaryWorkflow extends ApplicationWorkflow {
  protected override createRuntime() {
    return runtime(this.env);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = conversationSummaryKeySchema.parse({
      workspaceId: url.searchParams.get("workspaceId"),
      threadId: url.searchParams.get("threadId"),
      jobId: url.searchParams.get("jobId"),
    });
    const id = conversationSummaryWorkflowId(key);
    switch (url.pathname) {
      case "/start":
        await dispatchConversationSummary(env.CONVERSATION_SUMMARY_WORKFLOW, key, runtime(env));

        return Response.json({ id });
      case "/recover-only":
      case "/dispatch-marked-key": {
        const creates: unknown[] = [];
        let gets = 0;
        let deferred = false;
        const binding: Pick<Workflow<ConversationSummaryKey>, "create" | "get"> = {
          create: (options) => {
            creates.push(options?.params ?? null);

            return env.CONVERSATION_SUMMARY_WORKFLOW.create(options);
          },
          get: (instanceId) => {
            gets++;

            return env.CONVERSATION_SUMMARY_WORKFLOW.get(instanceId);
          },
        };
        const scannedKey = { ...key, recoveryOnly: true as const };
        try {
          await dispatchConversationSummary(
            binding,
            scannedKey,
            runtime(env),
            url.pathname === "/recover-only",
          );
        } catch {
          deferred = true;
        }

        return Response.json({ creates, gets, deferred });
      }
      case "/status":
        return Response.json(await (await env.CONVERSATION_SUMMARY_WORKFLOW.get(id)).status());
      case "/terminate-for-test":
        await (await env.CONVERSATION_SUMMARY_WORKFLOW.get(id)).terminate();

        return Response.json(null);
      case "/restart-for-test":
        // Test-only fault injection proves the durable ledger fences even a
        // manually replayed generation callback; production never restarts.
        await (await env.CONVERSATION_SUMMARY_WORKFLOW.get(id)).restart();

        return Response.json(null);
      case "/model-guard": {
        const execution = await invoke<ConversationSummaryExecution>("load", [key]);
        let calls = 0;
        const config = { ...env };
        const generate = createConversationSummaryModel(
          {
            run: () => {
              calls++;
              throw new Error("Must not call binding");
            },
          } as unknown as Ai,
          (policy) => {
            requireConversationSummaryPolicy(config, policy);
            config.CONVERSATION_SUMMARY_ENABLED = "false";
          },
        );
        try {
          await generate(execution);
        } catch {
          /* expected final binding guard */
        }

        return Response.json({ calls });
      }
      case "/admission-guard": {
        const execution = await invoke<ConversationSummaryExecution>("load", [key]);
        let databaseTouches = 0;
        const guardedEnv = {
          ...env,
          CONVERSATION_SUMMARY_ENABLED: "false",
          get HYPERDRIVE(): never {
            databaseTouches++;
            throw new Error("Disabled admission must not access the database");
          },
        };
        try {
          await createConversationSummaryRuntime(guardedEnv).reserve(execution, 4000);
        } catch {
          /* expected before DB access */
        }

        return Response.json({ databaseTouches });
      }
      case "/policy":
        return Response.json(readConversationSummaryPolicy(env));
      case "/prompt-bound": {
        const execution = await invoke<ConversationSummaryExecution>("load", [key]);
        const message = { id: key.jobId, role: "user" as const, text: "" };
        const candidate = { ...execution, messages: [message] };
        const overhead = measureConversationSummaryPrompt(candidate);
        message.text = "x".repeat(execution.policy.maxInputBytes - overhead);
        const exact = buildConversationSummaryPrompt(candidate);
        const admitted = conversationSummaryPrompt(candidate);
        message.text += '"';
        let extraRejected = false;
        try {
          conversationSummaryPrompt(candidate);
        } catch {
          extraRejected = true;
        }

        return Response.json({
          exactBytes: exact.inputBytes,
          inputTokenBound: admitted.inputTokenBound,
          extraRejected,
        });
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<ConversationSummaryEnvironment>;

export type { ConversationSummaryKey };
