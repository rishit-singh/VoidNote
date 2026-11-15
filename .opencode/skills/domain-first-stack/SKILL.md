---
name: domain-first-stack
description: Refactor or extend a full-stack application using consistent domain modules, explicit public APIs, readable formatting, minimal DTOs, typed configuration and recoverable optimistic state. Use for cross-layer architecture cleanup or substantive domain slices; preserve the host project's framework and persistence invariants.
---

# Domain-first full-stack engineering

Use this skill to make one coherent domain readable and correctly owned across
public contracts, services, persistence, queries, stores and UI. It also applies
to workflows and agents when those capabilities are in the agreed task.

This skill owns structural conventions. Load `change-with-confidence` for the
modification/refactoring workflow and evidence-led guidance maintenance. Keep shared
rules in their owning skill rather than maintaining competing copies.

## Start with evidence and scope

1. Read project instructions, current plans and the affected implementation.
2. Inspect the worktree and preserve unrelated changes. Respect Plan/Build mode and
   separate authorization for commits, pushes, deployments and data writes.
3. Identify observed defects versus hypotheses. Trace one actual read/mutation
   across the stack before proposing directories or abstractions.
4. Record domain ownership, supported behavior, invariants and acceptance criteria.
   Distinguish implemented, tested, deployed and product-accepted states.

## Uniform module convention

- Use the project's agreed domain vocabulary consistently at each layer.
- A cohesive module is one file. When it needs multiple responsibilities, use a
  domain directory with an explicit `index.ts` public API. Create only needed layers.
- Name files by responsibility: `drafts`, `commands`, `queries`, `repository`,
  `dto`, `capture`, `manifests`. Exported hooks retain conventional `use…` names.
- Consumers import public entry points; internal files import siblings directly.
  Export specific public values/types. Keep type-only public contracts free of
  runtime server/provider dependencies. Enforce import boundaries and cycles with
  suitable tooling rather than relying on directory names alone.
- Preserve framework route/file conventions. Routes adapt transport to application
  operations; components compose UI; repositories own scoped persistence.
- Group shared infrastructure by a concrete purpose. Extract shared behavior after
  establishing its real consumers and contract.
- Split oversized modules by authority and lifecycle, not arbitrary line counts.
  Renaming a mixed-responsibility module does not resolve ownership.

Typical layer/domain locations are `contracts/notes`, `server/notes`, `db/notes`,
`queries/notes`, `stores/notes`, `components/notes`. Adapt paths to the approved
project structure; these are examples, not required empty directories.

## Readability and enforcement

- Separate imports into consistent groups and distinguish type imports.
- Use meaningful blank lines between declarations, functions and logical stages,
  and around control-flow transitions/returns according to the agreed style.
- Keep related object fields together; separate semantic groups and lay out complex
  types/objects readably. Avoid compact nested ternaries/conditional spreads when
  named intermediate values make intent clearer. Use braces for control flow.
- Verify current formatter/linter support before choosing rule names/plugins.
  Formatters do not establish module boundaries or infer semantic statement groups.
- Establish non-conflicting enforcement; test that fix → format → lint is stable.
  Preserve strict type safety and use narrow, explained exceptions when necessary.
- Read representative resulting code. A green formatter is not proof of readability.

## Public contracts and persistence

- Define minimal list, detail, display, edit and history DTOs for actual consumers.
  Keep public DTOs independent of database rows and provider response models.
- Select required fields and map deliberately. Retain stable identities and minimal
  concurrency/evidence tokens needed for safe commands and citations.
- Authorize at the server/service boundary. Narrow DTOs supplement authorization;
  they do not replace it. Validate inputs and public outputs.
- Use existing transactions, receipts, revision conflicts and deletion guards.
  Change schema with new migrations; preserve applied migration history.
- Treat transport naming, domain semantics and performance as separate concerns.
  Inventory all callers before an API cutover and test real transport boundaries.

## Remote state and optimistic interactions

- The established query/cache layer owns remote records, freshness and pagination.
  Local stores own drafts, exact pending commands, preferences and runtime resources.
  Components own temporary view interactions.
- Scope state to identity/workspace generations. Cancel outgoing reads and reject
  late completions; preserve recoverable local work during account transitions.
- Make mutations read clearly: validate scope → persist intent → apply optimistic
  change → send command → reconcile outcome.
- Persist exact intent before transmission when uncertain outcomes need recovery.
  Distinguish local pending feedback from server acknowledgement.
- Roll back only a definitely rejected operation's contribution. Preserve later
  edits/concurrent successful commands; replay uncertain outcomes with identical IDs
  and payloads. Avoid whole-cache snapshots that overwrite newer work.
- Update affected query variants/pages deliberately, preserve ordering and stable
  identities, and keep background invalidation outside the interaction critical path.
- Define undo-before-acknowledgement and partial/large-target behavior explicitly.
  Server-authoritative destructive/external effects must remain truthfully labeled.

## Configuration and performance

- Give each policy one typed owner with defaults, bounds, units and visibility.
  Server deployment tuning uses validated runtime configuration. Expose only
  explicitly public client settings; distinguish runtime from build-time values.
- Use named constants for domain/protocol invariants. Do not mechanically turn every
  numeric literal into an environment variable. Remove duplicated unexplained policy.
- Pin/version settings affecting durable work so changing defaults cannot invalidate
  existing manifests, attempts or output interpretation.
- Measure input-to-visible feedback separately from persistence, network, auth,
  database, serialization and refetch time. Include payload sizes and query counts.
  Set targets from evidence; do not invent benchmark results or universal thresholds.
- Keep secrets and raw sensitive payloads out of telemetry. Verify live export
  independently of instrumentation code; telemetry failure must not fail user work.

## Projections, backfills and AI capabilities when in scope

- Preserve canonical evidence and source IDs. Define derived projection semantics,
  versioning and invalidation before writing a data backfill.
- Use the same transformation for normal writes and backfill. Provide bounded,
  scoped, resumable and idempotent operation with dry-run counts/checkpoints.
  Check source revision/deletion before publishing; test repeated runs and recovery.
- For AI, settle runtime responsibilities, source permissions, memory, tools,
  prompts, budgets, cancellation and authoritative output persistence before
  bootstrapping. Use the user's chosen inference platform.
- Keep execution/session state distinct from domain truth; persist versioned outputs
  with source provenance and validate citations. Enforce permissions in tools, not
  just prompts. Reconcile unknown external outcomes rather than assuming exactly-once
  execution. Consult matching platform skills/current docs for implementation.

## Execution and handoff

1. Define shared contracts and migrate one complete vertical slice.
2. Verify behavior, readability and import boundaries; apply the same convention to
   remaining domains with explicit migration/compatibility steps.
3. Delegate only when requested or project instructions authorize it. Assign disjoint
   ownership and provide goal, acceptance, exclusions, contracts, allowed actions,
   relevant skills and focused checks. Worktrees do not isolate cloud/test resources.
4. Prioritize meaningful race/recovery tests, DTO/transport contracts and real user
   journeys. Run affected checks; broaden only for unresolved integration concerns.
5. Report changes, verification, measured improvements, residual work and deployment
   separately. Update authorized guidance/plans to actual implementation evidence.
