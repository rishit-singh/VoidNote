import { handleTRPCRequest } from "@/server/trpc/http";
import { appRouter } from "@/server/trpc/router";

export const dynamic = "force-dynamic";

function handler(request: Request) {
  return handleTRPCRequest(request, appRouter);
}

export { handler as GET, handler as POST };
