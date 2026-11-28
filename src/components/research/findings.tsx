import { Badge } from "@/components/ui/badge";
import type { ResearchFinding } from "@/contracts/research";

const labels: Record<ResearchFinding["status"], string> = {
  supported: "Supported",
  "not-found": "Not found",
  ambiguous: "Ambiguous",
  conflicting: "Conflicting",
};

function safeSourceUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function ResearchFindings({ findings }: { findings: ResearchFinding[] }) {
  return (
    <div className="flex flex-col gap-6">
      {findings.map((finding) => (
        <article key={finding.key} className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{finding.question}</h3>
            <Badge variant="secondary">{labels[finding.status]}</Badge>
          </div>
          {finding.answer && (
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{finding.answer}</p>
          )}
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {finding.explanation}
          </p>
          {finding.citations.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                Sources ({finding.citations.length})
              </summary>
              <ol className="mt-3 flex list-decimal flex-col gap-4 pl-5">
                {finding.citations.map((citation, index) => {
                  const href = safeSourceUrl(citation.url);
                  return (
                    <li key={`${citation.sourceId}:${index}`} className="min-w-0">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="break-all underline underline-offset-4"
                        >
                          {citation.url}
                        </a>
                      ) : (
                        <span className="break-all">{citation.url}</span>
                      )}
                      <blockquote className="my-2 whitespace-pre-wrap break-words border-l-2 pl-3">
                        {citation.excerpt}
                      </blockquote>
                      <p className="text-xs text-muted-foreground">
                        Retrieved{" "}
                        <time dateTime={citation.retrievedAt}>
                          {new Date(citation.retrievedAt).toLocaleDateString()}
                        </time>
                        {citation.asOf && (
                          <>
                            {" "}
                            · As of{" "}
                            <time dateTime={citation.asOf}>
                              {new Date(citation.asOf).toLocaleDateString()}
                            </time>
                          </>
                        )}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </details>
          )}
        </article>
      ))}
    </div>
  );
}
