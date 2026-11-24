# Workspace UX follow-up

## Behavior

- Newly saved notes with empty or whitespace-only titles receive workspace-scoped
  names such as `Untitled note (1)`. Assignment happens on first successful save;
  offline drafts retain their pending placeholder until acknowledgement.
- The counter is transactional and receipt-protected. Retries retain the original
  number; rename and deletion do not recycle it. Existing notes are not backfilled.
  User-entered names remain ordinary editable titles, including manually entered
  numbered names. Clearing an existing title does not allocate another number.
- An acknowledgement merges the assigned name into newer non-title edits while
  preserving a newer user-entered title and checking replay/current revisions.
  Additive optional `titleGeneration` recovery metadata distinguishes transcript
  changes from title edits that return to the original empty value. Legacy v1
  snapshots remain readable; unknown title-edit history is preserved conservatively.
- Duplicate is removed. Start over keeps the original and creates a fresh note.
- Route-back controls are mobile-only at the existing 760px breakpoint.
- Page headers remain visible while content/list panes scroll. Recording controls
  remain shell-owned, preserving capture ownership across navigation.
- Explicit action outcomes use Sonner toasts. Autosave retains inline status;
  recoverable failures retain their inline retry controls.

## Verification and delivery

Deployed through PR #15 as commit `54c3bd9a04f89aaf3484ab702a58d356a81f3708`,
Cloudflare version `efde5d10-5d70-4056-a5d1-e5fe35a957c3`.
[Production CI](https://github.com/rishit-singh/VoidNote/actions/runs/45280235135)
passed all checks, deployment and health smoke. PR CI passed 219 database/unit
tests and 146 browser tests. A separate `https://voidnote.app/api/health` request
also returned `status: ok`.

The isolated PostgreSQL/unit suite passed 208 tests, including concurrent title allocation,
exact retries, rollback, workspace isolation and draft acknowledgement races.
The database is separate from application data. A subsequent focused run passed
56 store, hydration and toast lifecycle tests, including explicit title clears
and local resolution of a remotely deleted record. The auth/tRPC suite passed
23 tests.

Browser checks use the built Worker with mocked transport. `PLAYWRIGHT_PORT` can
select a separate local preview port (default 8788) for concurrent worktrees;
the suite still refuses to reuse an existing server.

- 36 focused Chromium UX tests passed: numbering, responsive navigation,
  independent/paginated scrolling, 760×320 landscape capture, and toast behavior.
- 49 affected Chromium regressions passed: query/account lifecycle, recording,
  playback, profile appearances, preferences, Home and transcript corrections.
- Final isolated navigation coverage passed 28 checks across Chromium and WebKit
  (14 per browser), including 760/761px Back visibility and desktop sidebar return.
- Reviewed desktop Home/profile and mobile note/transcript screenshots.
- Production Worker build, full typechecks, lint and formatting passed.
- Physical mobile keyboard and hosted recording acceptance remain separate from
  these mocked browser tests.

## Review corrections

- Field-specific title generations preserve explicit clears during first-save
  acknowledgement and reload/retry.
- Accepting a remotely deleted version reports a local resolution, including when
  a query observer recreates a clean tombstone baseline during the operation.
- Compact-height note chrome leaves a scrollable transcript and accessible
  recorder/navigation controls.
- Adding a toast sibling inside the keyed query-provider return retained SSR
  landing/loading DOM in the built application. Moving the host to the stable
  root layout and restoring the original provider shape resolved this. Browser
  assertions now require one raw `main`, no retained landing, and visible controls.

The user subsequently authorized commit, push, checked PR merge, the required
database migration and production verification.

## Migration integration

`0007_note_title_counters` is additive to the production `0006` baseline. Its
journal timestamp `1795051280628` is an intentional ordering allocation immediately
after `0006`, before the separate AI worktree's unpublished migrations. Drizzle
selects pending migrations by timestamp, not filename.

Read-only production preflight confirmed only `0000`–`0006` are applied, with
maximum timestamp `1795051280627`; counter/AI tables and the AI transcript-generation
column are absent. Checksums match `0001`–`0006`. The previously documented `0000`
checksum discrepancy remains untouched.

After reconciliation, Drizzle's snapshot/journal check passed and all 31 repository
tests passed against a fresh isolated PostgreSQL database using the renamed migration.

Production migration `0007` was applied before merge and verified read-only: all
seven prior ledger records remained unchanged, row-level security and all three
constraints are present, and PUBLIC/anon/authenticated have no table grants.

The AI branch owner must integrate this released baseline before delivery:

| Future tag                        | Journal index | Preserved timestamp |
| --------------------------------- | ------------- | ------------------- |
| `0008_analysis_foundation`        | 8             | `1795351619302`     |
| `0009_analysis_reconciliation`    | 9             | `1795352595887`     |
| `0010_analysis_dispatch_fairness` | 10            | `1795353054024`     |
| `0011_summary_inference_budget`   | 11            | `1795448328850`     |

Preserve AI SQL bytes and timestamps when renumbering its four SQL/snapshot files.
The foundation snapshot must descend from UX snapshot
`077096ba-99fc-4802-8e71-7ecd986fd6cf`; every AI snapshot must include
`public.note_title_counters`, with subsequent ancestry remaining linear. Merge both
domains into the schema. Changing only journal indices or parent IDs is insufficient.
Check shared-environment ledgers before integration; never rewrite applied SQL or
ledger rows. The independently owned AI worktree was not modified for this release.

## Scrollbar spacing follow-up

The user requested more space around the new independent scroll panes. Native
scroll containers now use Tailwind `pr-3` for 12px content clearance and `mr-2`
for an 8px inset from their containing edge, across Home, notes, profiles,
appearances, Settings and sidebar recent notes. Home applies its outer spacing
only at widths/heights where that outer region scrolls.

The follow-up preserves existing scroll ownership and header/recorder positioning.
Static independent review found no blockers. The Worker build, scoped ESLint,
formatting and whitespace checks passed, along with 48 existing layout, navigation
and preferences browser checks (Chromium and WebKit navigation). Reviewed desktop
Home/profile and mobile transcript/Settings screenshots. Transport remains mocked;
physical-device scrollbar and keyboard behavior are separate acceptance evidence.
