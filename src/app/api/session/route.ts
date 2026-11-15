import { requirePrincipal } from "@/auth/server";
import { sessionSchema } from "@/contracts/workspace";
import { withDatabase } from "@/db/client";
import { createWorkspaceRepository } from "@/db/repository";
import { apiResponse } from "@/server/api";

export const dynamic = "force-dynamic";

export function GET() {
  return apiResponse(async () => {
    const user = await requirePrincipal();

    const workspace = await withDatabase((db) =>
      createWorkspaceRepository(db).ensureWorkspace(user),
    );
    return sessionSchema.parse({ user, workspace });
  });
}
