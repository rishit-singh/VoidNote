"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/** Decorative sample waveform; real capture levels remain owned by the recorder. */
export function Waveform({
  reduceMotion,
  className,
}: {
  reduceMotion: boolean;
  className?: string;
}) {
  const count = 84;
  return (
    <svg
      className={cn("block h-10 w-full min-w-0 fill-vn-mint", className)}
      viewBox={`0 0 ${count * 7} 64`}
      aria-hidden="true"
    >
      <motion.g
        initial={{ scaleY: 1 }}
        whileInView={{ scaleY: reduceMotion ? 1 : [0.35, 1, 0.7, 1] }}
        viewport={{ once: true }}
        transition={{ duration: reduceMotion ? 0 : 1.2, ease: "easeInOut" }}
        className="origin-center [transform-box:fill-box]"
      >
        {Array.from({ length: count }, (_, index) => {
          const height = 6 + Math.abs(Math.sin(index * 1.7) * Math.cos(index * 0.31)) * 48;
          return (
            <rect
              key={index}
              x={index * 7 + 1}
              y={(64 - height) / 2}
              width="2.5"
              height={height}
              rx="1.25"
            />
          );
        })}
      </motion.g>
    </svg>
  );
}
