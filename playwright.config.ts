import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:8788";

export default defineConfig({
  testDir: "./tests/e2e",
  tsconfig: "./tests/e2e/tsconfig.json",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "webkit",
      testMatch: "upload-compatibility.spec.ts",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    // build:worker must run first; this serves its output through workerd.
    command: "bun run preview:worker --env production --ip 127.0.0.1 --port 8788",
    url: baseURL,
    // A dev server on this port must never stand in for the Worker preview.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      WRANGLER_SEND_METRICS: "false",
    },
  },
});
