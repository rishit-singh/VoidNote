"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { connectorStatusSchema } from "@/contracts/connectors";
import { queryPolicy } from "@/config/query";
import { getQueryRuntime } from "@/lib/query-runtime";

import { SlackBriefSharing } from "./SlackBriefSharing";

/** Settings-ready integration surface; the host supplies only verified identity. */
export function ConnectorSettings(props: { workspaceId: string; userId: string }) {
  const runtime = getQueryRuntime();

  const scoped =
    runtime.identity?.workspaceId === props.workspaceId && runtime.identity.userId === props.userId;

  const statusQuery = useQuery(
    runtime.trpc.connectors.slackStatus.queryOptions(
      { workspaceId: props.workspaceId },
      { enabled: scoped, staleTime: queryPolicy.staleTimeMs },
    ),
  );

  const statusData = statusQuery.data;

  const loadBriefs =
    scoped && statusData?.configured === true && statusData.connection === "connected";

  const briefsQuery = useQuery(
    runtime.trpc.assistant.artifacts.queryOptions(
      { workspaceId: props.workspaceId },
      { enabled: loadBriefs, staleTime: queryPolicy.staleTimeMs },
    ),
  );
  const connect = useMutation(
    runtime.trpc.connectors.connectSlack.mutationOptions({ retry: false }),
  );
  const share = useMutation(runtime.trpc.connectors.shareBrief.mutationOptions({ retry: false }));

  if (!scoped) {
    return <p role="status">Loading workspace connector…</p>;
  }
  if (statusQuery.isPending) {
    return <p role="status">Loading Slack connection…</p>;
  }

  const status = connectorStatusSchema.safeParse(statusQuery.data);
  if (!status.success) {
    return <p role="status">Slack connection status is unavailable.</p>;
  }
  const briefs = (briefsQuery.data ?? [])
    .filter((brief) => brief.kind === "file")
    .map((brief) => ({ id: brief.id, name: brief.name }));

  return (
    <SlackBriefSharing
      userId={props.userId}
      workspaceId={props.workspaceId}
      status={status.data}
      briefs={briefs}
      onConnect={(input) => connect.mutateAsync(input)}
      onShare={async (input) => {
        const result = await share.mutateAsync(input);
        if (runtime === getQueryRuntime()) {
          void runtime.queryClient.invalidateQueries(
            runtime.trpc.connectors.slackStatus.queryFilter({
              workspaceId: props.workspaceId,
            }),
          );
        }
        return result;
      }}
      briefsLoading={briefsQuery.isPending}
    />
  );
}
