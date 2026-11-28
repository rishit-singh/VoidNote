import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { it } from "node:test";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { z } from "zod";
import config from "../../drizzle.config";

void it("schema generation references auth.users without managing provider-owned objects", async () => {
  const directory = new URL("../../src/db/", import.meta.url);
  const files = (await readdir(directory)).filter(
    (file) => file === "schema.ts" || file.endsWith("-schema.ts"),
  );
  const modules = await Promise.all(
    files.map((file) => import(new URL(file, directory).href) as Promise<Record<string, unknown>>),
  );
  const managed = Object.fromEntries(modules.flatMap((module) => Object.entries(module)));
  const current: unknown = generateDrizzleJson(managed);
  const snapshot = z
    .object({
      tables: z.record(
        z.string(),
        z.object({
          foreignKeys: z.record(
            z.string(),
            z.object({
              schemaTo: z.string().optional(),
              tableTo: z.string(),
              onDelete: z.string(),
            }),
          ),
        }),
      ),
      schemas: z.record(z.string(), z.string()),
    })
    .parse(current);
  assert.deepEqual(config.schemaFilter, ["public"]);
  assert.ok(Object.keys(snapshot.tables).every((name) => name.startsWith("public.")));
  assert.deepEqual(snapshot.schemas, {});
  const fk = snapshot.tables["public.user_profiles"]?.foreignKeys.user_profiles_id_users_id_fk;
  assert.ok(fk);
  assert.equal(fk.schemaTo, "auth");
  assert.equal(fk.tableTo, "users");
  assert.equal(fk.onDelete, "restrict");

  const previous: unknown = JSON.parse(
    await readFile(new URL("../../drizzle/meta/0018_snapshot.json", import.meta.url), "utf8"),
  );
  const migration = await generateMigration(previous, current);
  assert.equal(migration.length, 1);
  assert.match(migration[0]!, /^ALTER TABLE "user_profiles" ADD CONSTRAINT/);
  assert.match(migration[0]!, /REFERENCES "auth"\."users"/);
  const recorded: unknown = JSON.parse(
    await readFile(new URL("../../drizzle/meta/0019_snapshot.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(await generateMigration(recorded, current), []);
});
