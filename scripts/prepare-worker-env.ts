import { readFile, writeFile } from "node:fs/promises";

// OpenNext copies every .env mode into the Worker, including local database and
// provider credentials. This app reads runtime configuration from Wrangler
// bindings/secrets; no environment-file defaults belong in the deployed bundle.
const file = new URL("../.open-next/cloudflare/next-env.mjs", import.meta.url);
const generated = await readFile(file, "utf8");
const modes = ["production", "development", "test"];
for (const mode of modes) {
  if (!generated.includes(`export const ${mode} =`)) {
    throw new Error("Unexpected OpenNext environment module; review before deployment.");
  }
}
await writeFile(file, modes.map((mode) => `export const ${mode} = {};\n`).join(""));
