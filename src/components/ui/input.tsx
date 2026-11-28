import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const inputVariants = cva("", {
  variants: {
    variant: {
      default: "text-base md:text-sm",
      search:
        "h-full rounded-none border-0 p-0 text-vn-text shadow-none [font:inherit] placeholder:text-vn-muted placeholder:opacity-100 focus-visible:!outline-none focus-visible:!shadow-none",
      title:
        "h-auto min-h-0 w-[min(100%,720px)] border-0 p-0 text-title text-vn-text shadow-none outline-0 placeholder:text-vn-text placeholder:opacity-100 [@media(max-width:760px)]:text-[21px]",
      noteTitle:
        "h-auto min-h-0 w-full border-0 p-0 text-[24px] font-medium leading-[32px] text-vn-text shadow-none outline-0 placeholder:text-vn-text placeholder:opacity-100 [@media(max-width:760px)]:text-[22px] [@media(max-width:760px)]:leading-[30px]",
      workspace:
        "rounded-[3px] border-vn-stroke px-3 py-2.5 text-vn-text [font:inherit] focus-visible:!outline focus-visible:!outline-1 focus-visible:!outline-offset-2 focus-visible:!outline-vn-stroke-strong",
      signin: "border-vn-stroke text-vn-text [font:inherit]",
    },
  },
  defaultVariants: { variant: "default" },
});

const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<"input"> & VariantProps<typeof inputVariants>
>(({ className, type, variant, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        inputVariants({ variant }),
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
