import { z } from "zod";
import { deleteSchema, idSchema, noteSchema, personSchema } from "@/contracts/workspace";
import { readJson, workspaceResponse } from "@/server/api";

type Context = { params: Promise<{ workspaceId: string; collection: string; id: string }> };
const collectionSchema = z.enum(["notes", "people"]);

export async function GET(request: Request, context: Context) {
  const { workspaceId, collection, id } = await context.params;
  return workspaceResponse(request, workspaceId, async (repo, principal, wid) => {
    const kind = collectionSchema.parse(collection);
    idSchema.parse(id);
    // Recovery may inspect a tombstone, but authorization is unchanged.
    const includeDeleted =
      z
        .enum(["true", "false"])
        .default("false")
        .parse(new URL(request.url).searchParams.get("includeDeleted") ?? undefined) === "true";
    return kind === "notes"
      ? noteSchema.parse(await repo.getNote(principal, wid, id, includeDeleted))
      : personSchema.parse(await repo.getPerson(principal, wid, id, includeDeleted));
  });
}

export async function DELETE(request: Request, context: Context) {
  const { workspaceId, collection, id } = await context.params;
  return workspaceResponse(request, workspaceId, async (repo, principal, wid) => {
    const kind = collectionSchema.parse(collection);
    idSchema.parse(id);
    const command = await readJson(
      request,
      deleteSchema.refine((value) => value.id === id),
    );
    return kind === "notes"
      ? noteSchema.parse(await repo.deleteNote(principal, wid, command))
      : personSchema.parse(await repo.deletePerson(principal, wid, command));
  });
}
