import { Box, Button, Paper, Typography } from '@mui/material';
import type { RhythmSuggestion } from '@api/rhythmsSchema';
import type { TemperatureFormat } from '@lib/temperatureConversions';
import { palette } from '@design/tokens';
import { CARD_OVERLINE, cardEvidence, cardLine, cardRowLine, REVIEW, reviewName } from './suggestionsCopy';

type Props = { name: string; entry: RhythmSuggestion; counted: number; format: TemperatureFormat; onReview: () => void };

// A ready suggestion, at the top of the page. No icon: the outline and the words carry it.
export default function SuggestionCard({ name, entry, counted, format, onReview }: Props) {
  return <Paper variant="outlined" sx={ { width: '100%', p: 2, borderColor: palette.border.accent } }>
    <Typography variant="caption" color="text.secondary" component="p">{ CARD_OVERLINE }</Typography>
    { entry.rows.length === 1 ? <>
      <Typography
        variant="body1"
        sx={ { mt: 0.5, overflowWrap: 'anywhere' } }>
        { cardLine(name, entry.rows, format) }
      </Typography>
      <Typography variant="body2" color="text.secondary">{ cardEvidence(entry.rows[0], counted) }</Typography>
    </> : <>
      <Typography variant="body1" sx={ { mt: 0.5, overflowWrap: 'anywhere' } }><bdi>{ name }</bdi></Typography>
      <Box component="ul" sx={ { listStyle: 'none', p: 0, m: 0 } }>
        { entry.rows.map((row, index) => <Typography
          key={ `${row.key}-${index}` }
          component="li"
          variant="body2"
          sx={ { overflowWrap: 'anywhere' } }>
          { cardRowLine(row, counted, format) }
        </Typography>) }
      </Box>
    </> }
    <Button
      variant="outlined"
      aria-label={ reviewName(name) }
      data-review={ entry.rhythmId }
      onClick={ onReview }
      sx={ { mt: 1, minHeight: 44 } }>
      { REVIEW }
    </Button>
  </Paper>;
}
