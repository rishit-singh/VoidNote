import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { RECENT_RECORDINGS_LIMIT } from "@/contracts/workspace-overview";
import type { useWorkspaceOverview } from "@/queries/workspace";

type OverviewQuery = ReturnType<typeof useWorkspaceOverview>;

function recordedTime(seconds: number) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const parts: string[] = [];
  if (hours) {
    parts.push(`${hours}h`);
  }
  if (minutes) {
    parts.push(`${minutes}m`);
  }
  if (remainder || !total) {
    parts.push(`${remainder}s`);
  }
  return parts.join(" ");
}

export function HomeMetrics({ overview }: { overview: OverviewQuery }) {
  const data = overview.data;
  const metrics = [
    { label: "Notes", value: data?.notes.toLocaleString() },
    { label: "Recordings", value: data?.recordings.toLocaleString() },
    { label: "Recorded time", value: data && recordedTime(data.recordedSeconds) },
  ];

  return (
    <section aria-label="Workspace overview" className="flex min-w-0 flex-col gap-4">
      {overview.isError && (
        <Alert variant="error">
          <AlertDescription>
            {data ? "Overview may be out of date." : "Overview unavailable."}
          </AlertDescription>
          <Button
            variant="outline"
            size="sm"
            disabled={overview.isFetching}
            onClick={() => void overview.refetch()}
          >
            Retry overview
          </Button>
        </Alert>
      )}
      {(data || !overview.isError) && (
        <dl className="m-0 grid grid-cols-[1fr_1fr_1.4fr] border-y border-vn-stroke py-5 sm:grid-cols-3 sm:py-6">
          {metrics.map(({ label, value }) => (
            <div
              key={label}
              className="flex min-w-0 flex-col gap-2 border-r border-vn-stroke px-3 first:pl-0 last:border-r-0 last:pr-0 sm:px-6"
            >
              <dt className="text-[12px] leading-[18px] text-vn-muted">{label}</dt>
              <dd className="m-0 break-words text-[20px] leading-7 text-vn-text tabular-nums sm:text-[24px] sm:leading-8">
                {value ?? <Skeleton className="h-7 w-16 max-w-full" />}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!data && !overview.isError && (
        <span role="status" className="sr-only">
          Loading overview
        </span>
      )}
    </section>
  );
}

export function RecentRecordings({ overview }: { overview: OverviewQuery }) {
  const recordings = overview.data?.recentRecordings.slice(0, RECENT_RECORDINGS_LIMIT);

  return (
    <section aria-labelledby="recent-recordings-title" className="flex min-w-0 flex-col gap-4">
      <h2
        id="recent-recordings-title"
        className="m-0 flex min-h-9 items-center text-[14px] font-medium leading-5 text-vn-text"
      >
        Recently recorded
      </h2>
      {!recordings && !overview.isError && (
        <div role="status" aria-label="Loading recent recordings">
          <Skeleton variant="row" className="h-[92px]" />
          <Skeleton variant="row" className="h-[92px]" />
          <Skeleton variant="row" className="h-[92px]" />
        </div>
      )}
      {!recordings && overview.isError && (
        <p className="m-0 text-[12px] leading-[18px] text-vn-muted">
          Recent recordings unavailable.
        </p>
      )}
      {recordings?.length === 0 && (
        <Empty className="px-0 md:px-0">
          <EmptyHeader>
            <EmptyTitle>No recordings yet</EmptyTitle>
            <EmptyDescription>Record or upload audio in a note.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {recordings && recordings.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Recent recordings">
          {recordings.map((recording) => (
            <li key={recording.id}>
              <Link
                href={`/notes/${encodeURIComponent(recording.noteId)}`}
                className="group/recording flex min-h-[92px] items-center gap-2 border-b border-vn-stroke py-[18px]"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-[7px]">
                  <span className="truncate text-[14px] leading-5 text-vn-text group-hover/recording:underline group-hover/recording:underline-offset-4">
                    {recording.title || "Untitled note"}
                  </span>
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] leading-[18px] text-vn-muted">
                    <span>{recordedTime(recording.durationSeconds)}</span>
                    <time dateTime={recording.createdAt}>
                      {new Date(recording.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                  </span>
                </span>
                <span
                  className="flex size-11 flex-none items-center justify-center text-[16px] text-vn-muted"
                  aria-hidden="true"
                >
                  ↗
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
