import { z } from "zod";
import {
  notesQuerySchema,
  peopleQuerySchema,
  noteListSchema,
  personListSchema,
  saveNoteSchema,
  savePersonSchema,
  noteSchema,
  personSchema,
} from "@/contracts/workspace";
import { readJson, workspaceResponse } from "@/server/api";

type Context = { params: Promise<{ workspaceId: string; collection: string }> };
const collectionSchema = z.enum(["notes", "people"]);

export async function GET(request: Request, context: Context) {
  const { workspaceId, collection } = await context.params;
  return workspaceResponse(request, workspaceId, async (repo, principal, wid) => {
    const kind = collectionSchema.parse(collection);
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return kind === "notes"
      ? noteListSchema.parse(await repo.listNotes(principal, wid, notesQuerySchema.parse(query)))
      : personListSchema.parse(
          await repo.listPeople(principal, wid, peopleQuerySchema.parse(query)),
        );
  });
}

export async function POST(request: Request, context: Context) {
  const { workspaceId, collection } = await context.params;
  return workspaceResponse(request, workspaceId, async (repo, principal, wid) => {
    const kind = collectionSchema.parse(collection);
    return kind === "notes"
      ? noteSchema.parse(
          await repo.saveNote(principal, wid, await readJson(request, saveNoteSchema)),
        )
      : personSchema.parse(
          await repo.savePerson(principal, wid, await readJson(request, savePersonSchema)),
        );
  });
}
