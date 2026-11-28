import { trace } from "@opentelemetry/api";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { patchFetch } from "next/dist/server/lib/patch-fetch";
import { GET } from "../../src/app/api/health/route";
import { ProviderRequestError, pyannote } from "../../src/server/pyannote";
import { instrumentWorker } from "../../src/telemetry/worker";

interface Env {
  PROVIDER_WORKFLOW: Workflow;
  PYANNOTE_API_KEY: string;
  NEXT_OTEL_FETCH_DISABLED?: string;
}

// CI runs Worker tests before the OpenNext build. Exercise the installed Next
// patch itself rather than copying its implementation or requiring build output.
const http = instrumentWorker<Env>({
  fetch(_request, env) {
    // OpenNext copies Worker string bindings into process.env on its first HTTP
    // request. The value here comes from wrangler.jsonc, never a fixture default.
    if (env.NEXT_OTEL_FETCH_DISABLED === undefined) {
      Reflect.deleteProperty(process.env, "NEXT_OTEL_FETCH_DISABLED");
    } else {
      process.env.NEXT_OTEL_FETCH_DISABLED = env.NEXT_OTEL_FETCH_DISABLED;
    }
    patchFetch({ workAsyncStorage, workUnitAsyncStorage });
    return GET();
  },
});

export class RecordingProviderWorkflow extends WorkflowEntrypoint<Env> {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const requestSpanActive = Boolean(trace.getActiveSpan());
    const submission = await step.do(
      "submit once",
      { retries: { limit: 0, delay: "1 second" } },
      async () => {
        try {
          const result = await pyannote(this.env.PYANNOTE_API_KEY).submit(
            "https://audio.fixture.test/recording",
            "https://callback.fixture.test/processing",
          );
          return { status: "submitted" as const, jobId: result.jobId };
        } catch (error) {
          if (!(error instanceof ProviderRequestError) || !error.ambiguous) throw error;
          return { status: "submission_unknown" as const };
        }
      },
    );
    if (submission.status === "submission_unknown") {
      return { ...submission, requestSpanActive };
    }
    const observation = await step.do(
      "observe acknowledged job",
      { retries: { limit: 0, delay: "1 second" } },
      async () => {
        const result = await pyannote(this.env.PYANNOTE_API_KEY).getState(submission.jobId);
        return { jobId: result.jobId, status: result.status };
      },
    );
    return { submission, observation, requestSpanActive };
  }
}

export default {
  async fetch(request, env, ctx) {
    switch (new URL(request.url).pathname) {
      case "/api/health":
        if (!http.fetch) throw new Error("Missing instrumented HTTP handler");
        return http.fetch(request, env, ctx);
      case "/start": {
        const instance = await env.PROVIDER_WORKFLOW.create({ id: "provider-regression" });
        return Response.json({ id: instance.id });
      }
      case "/status":
        return Response.json(
          await (await env.PROVIDER_WORKFLOW.get("provider-regression")).status(),
        );
      default:
        return new Response(null, { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
