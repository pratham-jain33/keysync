"use client";

import { starsForAccuracy } from "@/lib/stars";

const STAR_PATH =
  "M12 2l2.9 6.26 6.6.56-5 4.36 1.5 6.45L12 16.9 5.99 19.63l1.5-6.45-5-4.36 6.6-.56L12 2z";

/** Row of 3 stars reflecting an accuracy score. Set `animate` for the celebratory pop. */
export function Stars({
  accuracy,
  size = "md",
  animate = false,
}: {
  accuracy: number;
  size?: "sm" | "md" | "lg";
  animate?: boolean;
}) {
  const stars = starsForAccuracy(accuracy);
  const cls =
    size === "sm" ? "h-3.5 w-3.5" : size === "lg" ? "h-11 w-11 sm:h-14 sm:w-14" : "h-5 w-5";
  return (
    <span
      className="inline-flex items-center gap-1"
      role="img"
      aria-label={`${stars} out of 3 stars`}
    >
      {[0, 1, 2].map((i) => (
        <svg
          key={i}
          viewBox="0 0 24 24"
          className={`${cls}${animate ? " animate-pop" : ""}`}
          style={animate ? { animationDelay: `${200 + i * 180}ms` } : undefined}
          aria-hidden="true"
        >
          <path
            d={STAR_PATH}
            fill={i < stars ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={1.5}
            className={i < stars ? "text-accent" : "text-line-strong"}
          />
        </svg>
      ))}
    </span>
  );
}
