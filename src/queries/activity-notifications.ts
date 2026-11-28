import type { ActivityItem } from "@/contracts/activity";

const backgroundCompletionTypes = new Set<ActivityItem["type"]>([
  "transcript.ready",
  "summary.published",
  "summary.failed",
  "research.completed",
  "research.failed",
]);

export function isBackgroundCompletion(item: ActivityItem) {
  return item.executor !== "user" && backgroundCompletionTypes.has(item.type);
}

export function createActivityNotificationTracker(maxRemembered = 200) {
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  let latestCompletion: ActivityItem | null = null;

  return {
    consume(items: ActivityItem[], hasMore: boolean) {
      for (const item of items) {
        if (seen.has(item.id)) {
          continue;
        }

        seen.add(item.id);
        seenOrder.push(item.id);
        if (seenOrder.length > maxRemembered) {
          const expired = seenOrder.shift();
          if (expired) {
            seen.delete(expired);
          }
        }

        if (isBackgroundCompletion(item)) {
          latestCompletion = item;
        }
      }

      if (hasMore) {
        return null;
      }

      const completed = latestCompletion;
      latestCompletion = null;

      return completed;
    },
  };
}

export function safeActivityHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//") ? href : "/";
}
