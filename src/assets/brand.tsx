import type { SVGProps } from "react";

import { cn } from "@/lib/utils";
import { brandMarkPath } from "./brand-source";

export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
      className={cn("size-[26px] shrink-0 text-vn-mint", className)}
      {...props}
    >
      <path d={brandMarkPath} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Brand({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 font-medium tracking-[-0.06em]",
        compact ? "text-[13px]" : "text-[19px] [@media(max-width:640px)]:text-[17px]",
        className,
      )}
    >
      <BrandMark className={compact ? "size-[19px]" : undefined} />
      VoidNote<span className="-ml-[9px] text-vn-mint">.</span>
    </span>
  );
}

export function PlayMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d="m5 3 8 5-8 5V3Z" />
    </svg>
  );
}
