// One rhythm's schedule with a typical night where it differs, and the sentence that describes it.
import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import type { NightLog, Rhythm } from '@api/rhythmsSchema';
import { MIN_NIGHTS } from '@api/suggestionRules';
import type { TemperatureFormat } from '@lib/temperatureConversions';
import OverlayChart from './OverlayChart';
import { rhythmOverlay } from './rhythmOverlay';
import { typicalNightText } from './suggestionsCopy';

type Props = {
  rhythm: Rhythm;
  log: NightLog[];
  today: string;
  timeZone: string;
  format: TemperatureFormat;
  trackingOn: boolean;
  // A suggestion card already tells this rhythm's story.
  hasCard?: boolean;
  captionId: string;
};

export default function RhythmChart({ rhythm, log, today, timeZone, format, trackingOn, hasCard, captionId }: Props) {
  const { endMin, loF, hiF, plan, drawn, blocks } = useMemo(() => rhythmOverlay({ rhythm, log, today, timeZone, trackingOn }),
    [rhythm, log, today, timeZone, trackingOn]);
  const { on } = rhythm.night.power;
  const smart = rhythm.temperatureMode === 'smart';
  const showText = !hasCard && drawn >= MIN_NIGHTS;
  return <Box sx={ { width: '100%' } }>
    <OverlayChart endMin={ endMin } loF={ loF } hiF={ hiF } plan={ plan } blocks={ blocks } on={ on } format={ format }/>
    { /* Always rendered, so the card's aria-describedby never points at nothing. */ }
    <Typography id={ captionId } variant="caption" color="text.secondary" sx={ { display: 'block', mt: showText ? 1 : 0 } }>
      { /* Compared only once five nights can be drawn, so a match is never claimed unchecked. */ }
      { showText && typicalNightText(blocks, on, format, smart) }
    </Typography>
  </Box>;
}
