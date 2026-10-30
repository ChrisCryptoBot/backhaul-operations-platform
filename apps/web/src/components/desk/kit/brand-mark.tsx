import React from "react";

/**
 * The TrueLane mark: a gold T whose stem is broken by a short gap, the way a lane line is. Drawn from the phone app's own geometry
 * (components/ui/BrandMark.tsx, three rectangles on a 100 grid), so the desk, the splash and the favicon all carry the same shape.
 *
 * `driving` swaps the stem for lane dashes that scroll downward on a loop (the phone's launch screen does the same while it waits).
 * `parts` lets the splash draw the three pieces one at a time; each part has a class (`bm-bar`, `bm-up`, `bm-low`) to hang an animation on.
 */
export const BRAND_GOLD = "#E8A020";

const BAR = { x: 0, y: 0, w: 100, h: 17 } as const;
const STEM_X = 41.5;
const STEM_W = 17;
// The phone's gap is 5.5 of 100. Below about 48px that is a hairline, so the small rendition opens it to 9 (same shape, readable at a glance).
const gapFor = (size: number) => (size < 48 ? { top: 49.5, bottom: 58.5 } : { top: 50.25, bottom: 55.75 });

// Dashes for the driving state: 33 long, 5.5 apart, one period (38.5) per loop.
const DASH = 33;
const DASH_GAP = 5.5;
const PERIOD = DASH + DASH_GAP;

export function BrandMark({ size = 24, driving = false, className, title }: { size?: number; driving?: boolean; className?: string; title?: string }) {
  const gap = gapFor(size);
  return (
    <svg className={`brand-mark${driving ? " bm-driving" : ""}${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 100 100" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <rect className="bm-bar" x={BAR.x} y={BAR.y} width={BAR.w} height={BAR.h} fill={BRAND_GOLD} />
      {driving ? (
        <>
          <clipPath id="bm-stem-clip">
            <rect x={STEM_X} y={BAR.h} width={STEM_W} height={100 - BAR.h} />
          </clipPath>
          <g clipPath="url(#bm-stem-clip)">
            <g className="bm-dashes">
              {[-1, 0, 1, 2].map((i) => (
                <rect key={i} x={STEM_X} y={BAR.h + i * PERIOD} width={STEM_W} height={DASH} fill={BRAND_GOLD} />
              ))}
            </g>
          </g>
        </>
      ) : (
        <>
          <rect className="bm-up" x={STEM_X} y={0} width={STEM_W} height={gap.top} fill={BRAND_GOLD} />
          <rect className="bm-low" x={STEM_X} y={gap.bottom} width={STEM_W} height={100 - gap.bottom} fill={BRAND_GOLD} />
        </>
      )}
    </svg>
  );
}

/** The dash travel for one loop, in the mark's own units; the CSS keyframe reads it so the two never drift apart. */
export const BRAND_DASH_PERIOD = PERIOD;
