export const eventPolicy = {
  batchSize: 20,
  leaseSeconds: 60,
  maxAttempts: 8,
  retryBaseSeconds: 5,
  retryMaxSeconds: 300,
  changePageSize: 50,
} as const;

export function eventRetrySeconds(attempt: number) {
  return Math.min(
    eventPolicy.retryMaxSeconds,
    eventPolicy.retryBaseSeconds * 2 ** Math.max(0, attempt - 1),
  );
}
