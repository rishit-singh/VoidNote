# Live Workers AI summary proof — November 22, 2026

**Runtime compatibility and persistence passed. Product summary quality is not yet
accepted.** This is one synthetic conversation, not a representative evaluation set.

The user authorized DeepSeek V4.1 Flash, at most three attempts and $1 estimated
inference usage. No staging PostgreSQL connection existed, so the user selected
isolated local PostgreSQL + real local Think/Workflow + live Workers AI instead of
hosted staging. Production records, bindings and inference settings were untouched.

## Measured results

| Attempt | Prompt | Outcome | Input / output tokens | Model time | End-to-end | Estimated inference cost |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Production `summary-v1` | Saved, citations validate | 6,443 / 6,696 | 30.1 s | 30.7 s | $0.0099681 |
| 2 | Proof supplement `concise-grounding-v2` | Interrupted; safely failed on restart | Unknown | Unknown | Not a completed run | Reserve $0.0398304 |
| 3 | Proof supplement `concise-grounding-v2` | Saved, citations validate | 6,752 / 3,884 | 16.8 s | 18.1 s | $0.0066864 |

Successful-run costs total **$0.0166545**, conservatively ignoring attempt 3's
4,544 cached input tokens. Including the interrupted attempt's reserved bound gives
**$0.0564849 estimated/reserved**, below the authorized $1. This is not an invoice.
All three attempts are consumed; no further inference was made.

Published rates checked at execution: $0.30/M input, $1.20/M output, $0.006/M
cached input tokens. Source:
[Cloudflare model entry](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/).

The model used the forced `think_final_answer` tool once per completed run. The
proof requested no reasoning; the adapter reports reasoning usage as unknown,
so zero reasoning tokens cannot be independently asserted.

## Persistence and recovery

- The fixed source contained all ten passages and three assigned profiles:
  6,048 context bytes, transcript generation 4.
- Both successful jobs have exactly one PostgreSQL result, with separate result
  versions. The failed job has none.
- Admission plus duplicate-command replay completed in 144 ms and 169 ms for
  attempts 1 and 3 respectively. These are local samples, not latency benchmarks.
- After a full runtime restart, attempt 1 returned the identical result ID,
  identical stored usage and validated immutable R2 evidence, without inference.
- Attempt 2 was interrupted by the harness server's 120-second process lifetime,
  not by a model error. After restart, its exact command became failed with an
  explicit uncertain-outcome message. Automatic continuation was declined.
- Attempts 2 and 3 were not additional retries of attempt 1; each had its own
  explicit fixed command/job ID. The runner never automatically advances jobs.

This proves local persistent restart behavior. Hosted DO eviction, hosted
PostgreSQL connectivity, authenticated Summary UI and real audio remain separate.

## Quality assessment

Both completed outputs retained the final conditional private-pilot decision,
rejected public Friday launch, correct owners, no working-fix promise, unknown
replacement date and absence of a discussed budget amount.

The base prompt had material quality problems: seven repetitive quick-summary
bullets, unsupported uncertainty, unresolved questions promoted into tasks, and
citations supporting only part of multi-clause claims.

The experimental supplement shortened the output and corrected several of those
errors. It is not yet a production prompt: semantic citation gaps and overly strong
paraphrases remain, and some requested section limits were not obeyed. Further
work needs frozen multi-conversation evaluations and versioned prompt/policy
support, not silent replacement of settings pinned to existing jobs.

Quick-summary text fell from 147 to 58 words; detailed text from 265 to 125.
The second output still produced four uncertainties despite a three-item limit.
Specific remaining defects include treating unanswered invitations as definitively
not negative feedback, a memory claim whose quote omits its promised deliverable
and deadline, and a causal/temporal engagement claim unsupported by its excerpts.
The phrase "invited invitations" also needs copy improvement. Independent review
confirmed these findings; lexical validation alone would not catch them.

## Artifacts

- [`results.json`](results.json): synthetic outputs, usage, failed outcome and reload evidence.
- [`fixture.ts`](../../../tests/proofs/summary/fixture.ts): the complete synthetic source.
- [`instructions.ts`](../../../tests/proofs/summary/instructions.ts): proof-only supplement.
- [`runner guide`](../../../tests/proofs/summary/README.md): opt-in reproduction and budget boundaries.

The local proof servers were stopped. No production or staging deployment occurred.
