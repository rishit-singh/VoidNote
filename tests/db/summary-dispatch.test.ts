import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchSummaryJobs,
  summaryExecutionName,
  type SummaryWorkflowParams,
} from "../../src/ai/summary/dispatch";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const first: SummaryWorkflowParams = {
  workspaceId,
  jobId: "00000000-0000-4000-8000-000000000002",
};
const second: SummaryWorkflowParams = {
  workspaceId,
  jobId: "00000000-0000-4000-8000-000000000003",
};

void test("uncertain workflow creation is not acknowledged and does not block another job", async () => {
  const acknowledged: string[] = [];
  const failures: string[] = [];

  await dispatchSummaryJobs([first, second], {
    start(params) {
      if (params.jobId === first.jobId) {
        return Promise.reject(new Error("Create response was lost."));
      }
      return Promise.resolve(summaryExecutionName(params));
    },
    dispatched(params) {
      acknowledged.push(params.jobId);
      return Promise.resolve();
    },
    failed(params) {
      failures.push(params.jobId);
    },
  });

  assert.deepEqual(acknowledged, [second.jobId]);
  assert.deepEqual(failures, [first.jobId]);
});

void test("lost outbox acknowledgement retries the exact workflow identity", async () => {
  const starts: string[] = [];
  let acknowledgementAttempts = 0;
  let failures = 0;
  const operations = {
    start(params: SummaryWorkflowParams) {
      const id = summaryExecutionName(params);
      starts.push(id);
      return Promise.resolve(id);
    },
    dispatched() {
      acknowledgementAttempts += 1;
      return acknowledgementAttempts === 1
        ? Promise.reject(new Error("Database acknowledgement failed."))
        : Promise.resolve();
    },
    failed() {
      failures += 1;
    },
  };

  await dispatchSummaryJobs([first], operations);
  await dispatchSummaryJobs([first], operations);

  assert.deepEqual(starts, [summaryExecutionName(first), summaryExecutionName(first)]);
  assert.equal(acknowledgementAttempts, 2);
  assert.equal(failures, 1);
});

void test("terminal jobs and mismatched workflow acknowledgements are not marked dispatched", async () => {
  const acknowledged: string[] = [];
  const failures: string[] = [];

  await dispatchSummaryJobs([first, second], {
    start(params) {
      return Promise.resolve(params.jobId === first.jobId ? null : summaryExecutionName(first));
    },
    dispatched(params) {
      acknowledged.push(params.jobId);
      return Promise.resolve();
    },
    failed(params) {
      failures.push(params.jobId);
    },
  });

  assert.deepEqual(acknowledged, []);
  assert.deepEqual(failures, [second.jobId]);
});

void test("acknowledged active jobs are reconciled again after a terminal-write outage", async () => {
  const starts: string[] = [];
  const confirmations: string[] = [];
  const failures: string[] = [];
  let firstChecks = 0;

  const operations = {
    start(params: SummaryWorkflowParams) {
      starts.push(params.jobId);
      if (params.jobId === first.jobId) {
        firstChecks += 1;
        if (firstChecks === 2) {
          return Promise.reject(new Error("Terminal job write is temporarily unavailable."));
        }
        if (firstChecks === 3) {
          // The next check persisted the deferred terminal state.
          return Promise.resolve(null);
        }
      }
      return Promise.resolve(summaryExecutionName(params));
    },
    dispatched(params: SummaryWorkflowParams) {
      confirmations.push(params.jobId);
      return Promise.resolve();
    },
    failed(params: SummaryWorkflowParams) {
      failures.push(params.jobId);
    },
  };

  await dispatchSummaryJobs([first, second], operations);
  await dispatchSummaryJobs([first, second], operations);
  await dispatchSummaryJobs([first, second], operations);

  assert.deepEqual(starts, [
    first.jobId,
    second.jobId,
    first.jobId,
    second.jobId,
    first.jobId,
    second.jobId,
  ]);
  assert.deepEqual(confirmations, [first.jobId, second.jobId, second.jobId, second.jobId]);
  assert.deepEqual(failures, [first.jobId]);
});
