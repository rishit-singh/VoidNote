import { cn } from "@/lib/utils";

function Skeleton({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "row" }) {
  return (
    <div
      className={cn(
        "vn-skeleton rounded-md bg-primary/10",
        variant === "row" &&
          "rounded-none border-b border-vn-stroke bg-gradient-to-r from-vn-surface via-vn-hover to-vn-surface",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
