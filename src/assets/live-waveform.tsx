import { cn } from "@/lib/utils";

export function LiveWaveform({ levels, className }: { levels: number[]; className?: string }) {
  return (
    <svg
      width="96"
      height="26"
      viewBox="0 0 96 26"
      role="img"
      aria-label="Live microphone waveform"
      className={cn("hidden shrink-0 text-muted-foreground sm:block", className)}
    >
      {levels.map((level, index) => (
        <line
          key={index}
          x1={index * 4 + 2}
          x2={index * 4 + 2}
          y1={13 - Math.max(1, level * 12)}
          y2={13 + Math.max(1, level * 12)}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
