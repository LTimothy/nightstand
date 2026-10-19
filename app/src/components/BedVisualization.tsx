import { Box } from '@mui/material';
import { useMemo } from 'react';
import { computeBedSpine, scaleVisualDeg } from '@lib/bedGeometry.ts';
import { palette } from '@design/tokens';
import { useTweenedNumber } from './useTweenedNumber';

interface BedVisualizationProps {
  headPosition: number; // 0-45 degrees, matches the base's real head-tilt range
  feetPosition: number; // 0-30 degrees, matches the base's real feet-tilt range
}

// A schematic side profile: two hinged panels (head, feet) either side of a
// fixed centre platform, matching how adjustable bases are actually built.
// Flat shapes with no shading or texture, since nothing here but the
// angles carries a state.
const VIEW_W = 400;
const BASELINE_Y = 96;
const HEAD_PIVOT_X = 182;
const FEET_PIVOT_X = 218;
const SEGMENT_LEN = 154;
const MATTRESS_THICKNESS = 34;
// The base's real range (0-45 / 0-30) barely reads as motion over a 154px
// segment, so the visual tilt is exaggerated relative to the physical degrees.
const MAX_VISUAL_DEG = 34;

export default function BedVisualization({
  headPosition,
  feetPosition,
}: BedVisualizationProps) {
  const headTarget = scaleVisualDeg(headPosition, 45, MAX_VISUAL_DEG);
  const feetTarget = scaleVisualDeg(feetPosition, 30, MAX_VISUAL_DEG);
  const headDeg = useTweenedNumber(headTarget);
  const feetDeg = useTweenedNumber(feetTarget);

  const { spinePath, pillow } = useMemo(
    () => computeBedSpine(headDeg, feetDeg, {
      headPivotX: HEAD_PIVOT_X,
      feetPivotX: FEET_PIVOT_X,
      baselineY: BASELINE_Y,
      segmentLen: SEGMENT_LEN,
    }),
    [headDeg, feetDeg],
  );

  const pillowCx = pillow.x;
  const pillowCy = pillow.y - MATTRESS_THICKNESS / 2 - 9;

  return (
    <Box sx={ { width: '100%', maxWidth: 400, mx: 'auto' } }>
      <svg
        viewBox={ `-14 -34 ${VIEW_W + 28} 176` }
        width="100%"
        height="160"
        role="img"
        aria-label={ `Base tilted ${headPosition}° at the head, ${feetPosition}° at the feet` }
      >
        { /* fixed base platform the panels hinge from */ }
        <rect
          x={ -6 }
          y={ BASELINE_Y + MATTRESS_THICKNESS / 2 + 6 }
          width={ VIEW_W + 12 }
          height={ 10 }
          rx={ 5 }
          fill={ palette.bg.raised }
        />

        <path
          d={ spinePath }
          fill="none"
          stroke={ palette.border.control }
          strokeWidth={ MATTRESS_THICKNESS }
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <ellipse cx={ pillowCx } cy={ pillowCy } rx={ 29 } ry={ 14 } fill={ palette.text.secondary } />
      </svg>
    </Box>
  );
}
