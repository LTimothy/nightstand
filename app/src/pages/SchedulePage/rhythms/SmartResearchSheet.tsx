/* eslint-disable react/no-multi-comp */
// Each phase's study list is private to this sheet.
import { useId, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Link, Stack, Typography } from '@mui/material';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { palette, weight } from '@design/tokens';
import { SCROLL_SHEET } from './sheetStyles';

type Source = { cite: string; title: string; href: string; tested: string };
type Phase = { heading: string; does: string; why: string; sources: Source[] };

// Each citation was checked against PubMed and its DOI. The app says what a study tested and in whom, never its effect sizes.
const PHASES: Phase[] = [
  {
    heading: 'When you get into bed',
    does: 'With Warm start on, the bed turns on 30 minutes before bedtime (20 with Gentle) and sits one or two steps above '
      + 'your base temperature. It is off for a sleep that is mostly during the day or shorter than 3 hours.',
    why: 'Falling asleep comes with the body giving off heat through the skin. A slightly warm bed is meant to feel comfortable '
      + 'while that happens.',
    sources: [
      {
        cite: 'Kräuchi and others, 1999',
        title: 'Warm feet promote the rapid onset of sleep',
        href: 'https://doi.org/10.1038/43366',
        tested: '18 healthy young men in a sleep lab. Compared skin temperature at the hands and feet with how quickly they fell '
          + 'asleep. Nobody was warmed.',
      },
      {
        cite: 'Raymann and others, 2005',
        title: 'Cutaneous warming promotes sleep onset',
        href: 'https://doi.org/10.1152/ajpregu.00492.2004',
        tested: '8 healthy adults in a lab, napping many times during the day. Gently warmed the skin with a suit and timed how '
          + 'quickly they fell asleep.',
      },
    ],
  },
  {
    heading: 'Once you have settled in',
    does: 'The bed cools one step at a time to one or two steps below your base, then holds there through the night. With sleep '
      + 'tracking on, the cool-down waits until you have settled in bed; otherwise it follows the clock from bedtime.',
    why: 'In one lab study, a mattress that drew heat away during sleep was linked with a little more deep sleep and a slightly lower '
      + 'heart rate. The Pod\'s curve has not been tested for this.',
    sources: [
      {
        cite: 'Herberger and others, 2024',
        title: 'Enhanced conductive body heat loss during sleep increases slow-wave sleep and calms the heart',
        href: 'https://doi.org/10.1038/s41598-024-53839-x',
        tested: '72 adults at three sleep labs, each sleeping on a mattress that draws heat away and on a regular one. Measured sleep '
          + 'stages and heart rate. The mattress was passive, and one author works for its maker.',
      },
      {
        cite: 'Okamoto-Mizuno and Mizuno, 2012',
        title: 'Effects of thermal environment on sleep and circadian rhythm',
        href: 'https://doi.org/10.1186/1880-6805-31-14',
        tested: 'A review of studies on how heat, cold and humidity in the bedroom affect sleep.',
      },
      {
        cite: 'Dijk and Czeisler, 1995',
        title: 'Contribution of the circadian pacemaker and the sleep homeostat to sleep propensity, sleep structure, '
          + 'electroencephalographic slow waves, and sleep spindle activity in humans',
        href: 'https://doi.org/10.1523/JNEUROSCI.15-05-03526.1995',
        tested: '8 men living on a 28-hour day in a lab. Looked at how sleep changes across the night, counted from when sleep '
          + 'starts. Waiting until you settle is our reading of it, not something it tested.',
      },
    ],
  },
  {
    heading: 'Before you wake',
    does: 'With Warm-up on, the bed warms gently over the last 30 to 45 minutes before your wake time (less for a short or '
      + 'daytime sleep), then goes back to your base 30 minutes after it. This happens with or without an alarm.',
    why: 'This step is there so you wake to a comfortable bed. Studies have not shown that it makes waking easier. It is kept '
      + 'short because warming the bed for much of the night made sleep more broken in one study.',
    sources: [
      {
        cite: 'Fletcher and others, 1999',
        title: 'Sleeping with an electric blanket: effects on core temperature, sleep, and melatonin in young adults',
        href: 'https://doi.org/10.1093/sleep/22.3.313',
        tested: '16 young adults, with an electric blanket on for the second half of the night. It did not test a short '
          + 'warm-up before waking.',
      },
    ],
  },
];

// A study title is a link on its own line, so it gets a whole 44 px row to tap.
const studyLinkSx = { color: palette.accent, display: 'flex', alignItems: 'center', minHeight: 44 } as const;

function PhaseSection({ phase }: { phase: Phase }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return <Box component="section" sx={ { mt: 3 } }>
    <Typography component="h3" sx={ { fontSize: 16, fontWeight: weight.heading } }>{ phase.heading }</Typography>
    <Typography variant="body2" sx={ { mt: 0.5 } }>{ phase.does }</Typography>
    <Typography variant="body2" sx={ { mt: 1 } }>{ phase.why }</Typography>
    <Button
      aria-expanded={ open }
      aria-controls={ listId }
      endIcon={ <ExpandMore sx={ { transform: open ? 'rotate(180deg)' : undefined } }/> }
      onClick={ () => setOpen(value => !value) }
      sx={ { px: 0, mt: 0.5, minHeight: 44 } }>
      Studies ({ phase.sources.length })
    </Button>
    { open && <Stack id={ listId } component="ul" spacing={ 1.5 } sx={ { listStyle: 'none', p: 0, m: 0 } }>
      { phase.sources.map(source => <Box
        component="li"
        key={ source.href }
        sx={ { pl: 1.5, borderLeft: `2px solid ${palette.border.medium}`, overflowWrap: 'anywhere' } }>
        <Link href={ source.href } target="_blank" rel="noopener noreferrer" variant="body2" sx={ studyLinkSx }>
          { source.title }
        </Link>
        <Typography variant="body2" color="text.secondary">{ source.cite }</Typography>
        <Typography variant="body2" sx={ { mt: 0.5 } }>{ source.tested }</Typography>
      </Box>) }
    </Stack> }
  </Box>;
}

export default function SmartResearchSheet({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return <Dialog
    open
    onClose={ onClose }
    aria-labelledby={ titleId }
    fullWidth
    maxWidth="sm"
    scroll="paper"
    sx={ SCROLL_SHEET }>
    <DialogTitle id={ titleId }>The research behind it</DialogTitle>
    <DialogContent dividers>
      <Typography variant="body2" color="text.secondary">
        Comfortable when you lie down, a little cooler once you have settled in bed, and warming gently before your wake time. Changes
        are small and gradual. The step sizes and timings are our estimates: these studies used other beds and small groups of
        people, and none of them tested this curve.
      </Typography>
      { PHASES.map(phase => <PhaseSection key={ phase.heading } phase={ phase }/>) }
      <Typography variant="body2" sx={ { mt: 3 } }>
        This is a general starting point from published research, not a medical recommendation and not tuned to your own data, so
        adjust it to what feels right.
      </Typography>
    </DialogContent>
    <DialogActions>
      <Button onClick={ onClose } sx={ { minHeight: 44 } }>Close</Button>
    </DialogActions>
  </Dialog>;
}
