import { z } from "zod";
import { historySchema, idSchema, listQuerySchema } from "@/contracts/workspace";
import { workspaceResponse } from "@/server/api";

const querySchema = listQuerySchema.extend({
  entityType: z.enum(["note", "person"]),
  entityId: idSchema,
});

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await context.params;
  return workspaceResponse(request, workspaceId, async (repo, principal, wid) => {
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return historySchema.parse(
      await repo.history(principal, wid, query.entityType, query.entityId, query),
    );
  });
}
