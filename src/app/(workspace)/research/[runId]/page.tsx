import { notFound } from "next/navigation";

import { WorkspaceResearchRunPage } from "@/components/research/ResearchRunPanel";
import { idSchema } from "@/contracts/workspace";

export default async function ResearchRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId: rawRunId } = await params;
  const runId = idSchema.safeParse(rawRunId);

  if (!runId.success) notFound();

  return <WorkspaceResearchRunPage runId={runId.data} />;
}
