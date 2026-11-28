import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Stable component identities keep paragraph/URL/code DOM nodes mounted when
// panel width or query status changes. The scroll hook anchors to these nodes.
const markdownComponents: Components = {
  a: ({ href, children }) => {
    const safeUrl = href ? safeMarkdownHref(href) : null;
    if (!safeUrl) return <span>{children}</span>;
    const external = /^https?:\/\//i.test(safeUrl);
    return (
      <a
        href={safeUrl}
        className="underline underline-offset-4"
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  },
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto overscroll-x-contain">
      <table className="border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  pre: ({ children }) => (
    <pre className="whitespace-pre overscroll-x-contain [overflow-wrap:normal]">{children}</pre>
  ),
};

export function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 text-[13px] leading-[23px] [overflow-wrap:anywhere] [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_table]:min-w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc">
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function safeMarkdownHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
