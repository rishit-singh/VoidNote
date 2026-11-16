import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea"> & { variant?: "default" | "workspace" }
>(({ className, variant = "default", ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        variant === "default" && "text-base md:text-sm",
        variant === "workspace" &&
          "rounded-[3px] border-vn-stroke px-3 py-2.5 text-vn-text [font:inherit] focus-visible:!outline focus-visible:!outline-1 focus-visible:!outline-offset-2 focus-visible:!outline-vn-stroke-strong",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
