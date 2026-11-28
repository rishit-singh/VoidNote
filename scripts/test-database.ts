import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

// Each SQL suite owns an empty dedicated database and closes its own client.
// Separate processes avoid reusing an ended fixture singleton across test files;
// serial execution preserves the database ownership/teardown contract.
const files = (await readdir("tests/db")).filter((file) => file.endsWith(".test.ts")).sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["test", "--timeout", "30000", `tests/db/${file}`], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
