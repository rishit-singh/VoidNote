# Research evidence v2 — implementation and evidence

**Status: implemented and locally verified; live-provider acceptance remains open.**
This note records the bounded research-run path and its evidence as of November
27, 2026. It does not claim live-provider, model-quality, hosted, or deployment
acceptance.

## Implemented architecture

- **Assistant entry:** the native Think assistant uses the pinned
  `assistant-skills-v6` bundle for general research. It is instructed to check saved evidence
  with `research_lookup` before dispatch, can inspect a candidate with
  `research_get`, and submits new work through `research_dispatch`. A queued or
  running run is accepted work, not a completed answer; follow-up uses
  `work_list` and `research_status`. General research does not require a
  resolved contact.
- **Run execution:** research runs execute in a standard Cloudflare Workflow
  (`ResearchRunWorkflow`), with a stable run ID, bounded retries and timeouts.
  This is not a ThinkWorkflow. The assistant uses native Think; it is separate
  from this research-run Workflow.
- **Durable evidence:** Postgres stores run inputs and pinned policy, per-query
  discovery checkpoints, bounded immutable source-text snapshots, inference
  receipts/results, validated findings, and the immutable report. Research
  source snapshots are bounded SQL records—not general research objects in R2.
  Citations retain source identity, URL, retrieval time, and exact excerpt
  offsets. Report publication and its application event commit atomically.
- **Saved-source reuse:** fresh snapshots from up to five recent completed runs
  by the initiating actor are considered before network retrieval, alongside
  applicable legacy contact evidence. Explicit supplied URLs take priority.
  Snapshot eligibility uses the run's pinned `maxSnapshotAgeDays` (default 7);
  this does not establish the date or currentness of a claim. Supplemental
  selection requires meaningful question terms, and discovery stops when its
  source-count or byte capacity is exhausted. This is bounded candidate reuse,
  not an exhaustive search of all historical source text.
- **Recovery and authority:** stable command/operation IDs and checkpoints fence
  uncertain paid work against replay. Saved sources and discovery candidates
  are rehydrated for Workflow retries; known usage can be settled after
  cancellation. Workspace, run, person/contact revision, and cancellation
  fences are checked at acceptance and publication boundaries.
- **Bounds and enablement:** question, source, evidence, response-byte,
  and timeout limits are policy-bound; source retrieval concurrency is bounded.
  Research inference is off
  unless explicitly enabled; source discovery additionally requires its
  configured provider, credential, and enablement. Pinned model and budget
  defaults remain disabled.

## User-facing examples

These are representative requests and deterministic fixtures, not evidence of
semantic adherence by a real model:

- “What did we already find about this product’s pricing?” — check and reuse
  saved evidence before dispatch.
- “Research current prices for this product.” — check existing evidence, then
  dispatch only if needed; do not invent a price or imply currentness without
  dated evidence.
- “Research whether this product supports offline mode using these sources:
  [URLs].” — the mocked V6 runtime checks lookup-before-dispatch and preserves
  the supplied-source-only request.
- “Is that research done?” — inspect accepted work and its status without
  submitting it again.

## Verification evidence

| Evidence                                                                                                                                                                         | Result                             | What it establishes—and does not                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Research-run repository DB tests](../tests/db/research-runs-repository.test.ts)                                                                                                 | **12 passed**                      | Isolated-DB command/semantic deduplication, revision/publication fences, cancellation accounting, atomic report/events, exact saved-source provenance, bounded and scoped snapshot reuse, distinct lookup results.                                                                       |
| [Research-run runtime DB tests](../tests/db/research-runs-runtime.test.ts)                                                                                                       | **9 passed**                       | Real isolated DB with fake AI and mocked discovery: saved-source hydration/reuse, once-only inference, publication retry, secondary-discovery recovery, known usage after checkpoint failure/cancellation, unknown holds, source-capacity enforcement and rejection of irrelevant reuse. |
| [Assistant runtime tests](../tests/worker/assistant-runtime.test.ts)                                                                                                             | **76 passed**, previously reported | Mocked Think tool flow, including V6 lookup/dispatch and accepted-work follow-up. This is runtime-flow evidence, not real-model quality.                                                                                                                                                 |
| [Selective-context tests](../tests/worker/assistant-selective-context.test.ts)                                                                                                   | **3 passed**, previously reported  | Pinned V6 context/tool contract and historical V5 behavior.                                                                                                                                                                                                                              |
| [Transcript filter DB test](../tests/db/assistant-transcript-filters.test.ts)                                                                                                    | **1 passed**, expanded rerun       | Speaker/person/time filtering, authorization, and cursor rejection when implicit latest processing run changes despite equal generation/order.                                                                                                                                           |
| Focused synthesis, validation, pipeline, selective context, invalidation and telemetry tests                                                                                     | **57 passed**                      | Exact citations/offsets, honest partial reports, stopping unknown/global failures, provider-visible version contracts, scoped cache invalidation, exported execution versus quality attributes.                                                                                          |
| Built-Worker browser tests: [general research](../tests/e2e/research-runs.spec.ts), [contact research](../tests/e2e/research.spec.ts), [activity](../tests/e2e/activity.spec.ts) | **3 + 5 + 2 passed**               | Mocked application APIs with strict request validation: report evidence, pending cancellation, completion races, refresh-error retention, assistant task links, legacy retries and activity.                                                                                             |
| Worker build; full TypeScript; ESLint; Prettier                                                                                                                                  | **Passed**                         | Final snapshot-reuse changes passed affected lint, all TypeScript projects, repository formatting and the production Worker build.                                                                                                                                                       |

All DB evidence above uses isolated test data. No live research provider or
production model call is established by these checks. The Workflow class is
exported by the Worker entry point rather than the server-safe module barrel;
the post-fix `build:worker` check passed.

## Outstanding acceptance

- Process death before an external response can be durably recorded remains an
  uncertain outcome. Exact provider-operation fences preserve legitimate holds
  rather than spending again; this is distinct from transient checkpoint recovery.
- Real-provider behavior, semantic/model quality, hosted acceptance, production
  migrations, and deployment are not established here. Migration `0020` was
  generated/applied only in the isolated DB test fixture; no application-data
  migration, commit, push, or deployment is authorized by this work.
- Global assistant/agenda behavior and FTS work remain deferred.
