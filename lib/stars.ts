// Star ratings and coach microcopy for the post-run report.
//
// The game-feel layer: a run earns 0–3 stars from note accuracy, and the
// report pairs the score with one encouraging headline plus one concrete
// next step. Original design; thresholds follow the common 60/80/95 split.

export const STAR_THRESHOLDS = { 1: 60, 2: 80, 3: 95 } as const;

export type StarCount = 0 | 1 | 2 | 3;

export function starsForAccuracy(acc: number): StarCount {
  if (acc >= STAR_THRESHOLDS[3]) return 3;
  if (acc >= STAR_THRESHOLDS[2]) return 2;
  if (acc >= STAR_THRESHOLDS[1]) return 1;
  return 0;
}

/** Big celebratory headline for the report. Pure encouragement. */
export function headlineFor(stars: StarCount): string {
  switch (stars) {
    case 3:
      return "Flawless!";
    case 2:
      return "Great playing!";
    case 1:
      return "Nice progress!";
    default:
      return "Good effort!";
  }
}

/** One concrete next step, tuned to how the run went. */
export function coachLine(stars: StarCount): string {
  switch (stars) {
    case 3:
      return "This one's yours. Try it at full tempo — or pick a harder song.";
    case 2:
      return "Almost perfect. Loop your weakest bars to push past 95%.";
    case 1:
      return "Solid foundation. Slow to 0.5× on the tricky parts, then build back up.";
    default:
      return "Slow right down to 0.25× and loop one section at a time. Speed comes later.";
  }
}
