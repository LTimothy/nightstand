import { isAxiosError } from 'axios';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import SectionHeading from '@components/SectionHeading';
import type { useSuggestions } from '@api/rhythms';
import type { Rhythm, SideRhythms, SuggestionsResponse } from '@api/rhythmsSchema';
import {
  AWAY_LINE, hiddenForLine, LOAD_ERROR, nearLine, reasonLine, REVIEW, reviewName, SECTION_TITLE, sectionCaption, SHOW_NIGHTS,
} from './suggestionsCopy';

type Props = {
  sideData: SideRhythms;
  suggestions: Pick<ReturnType<typeof useSuggestions>, 'data' | 'error' | 'isError' | 'refetch'>;
  away: boolean;
  onShowNotes: () => void;
  onReview: (rhythmId: string) => void;
};

type SectionLine = { id: string; text: string; review?: string };

// A rhythm with a card has no line here; a near miss, then a running hide, then the reason.
function lineFor(rhythm: Rhythm, data: SuggestionsResponse): SectionLine | null {
  const entry = data.suggestions.find(candidate => candidate.rhythmId === rhythm.id);
  const nights = data.nights[rhythm.id];
  if (entry && !entry.near) return null;
  if (entry && nights) return { id: rhythm.id, text: nearLine(rhythm.name, entry.rows[0], nights.counted), review: reviewName(rhythm.name) };
  const later = data.dismissed.find(hidden => hidden.rhythmId === rhythm.id && hidden.scope === 'later');
  if (later) return { id: rhythm.id, text: hiddenForLine(rhythm.name, later.nightsLeft) };
  const text = nights ? reasonLine(rhythm.name, nights, rhythm.temperatureMode) : null;
  return text ? { id: rhythm.id, text } : null;
}

// How counting is going for each rhythm, after the rhythms themselves. An older Pod without the route shows nothing.
export default function SuggestionsSection({ sideData, suggestions, away, onShowNotes, onReview }: Props) {
  const { data, error, isError, refetch } = suggestions;
  if (isAxiosError(error) && error.response?.status === 404) return null;
  if (data && !data.enabled) return null;
  const lines = data ? Object.values(sideData.rhythms).flatMap(rhythm => {
    const line = lineFor(rhythm, data);
    return line ? [line] : [];
  }) : [];
  return <Stack component="section" aria-labelledby="suggestions-heading" spacing={ 1.5 } sx={ { width: '100%' } }>
    <SectionHeading id="suggestions-heading" tabIndex={ -1 } sx={ { outline: 'none' } }>{ SECTION_TITLE }</SectionHeading>
    { isError && !data && <Alert
      severity="warning"
      action={ <Button onClick={ () => void refetch() } sx={ { minHeight: 44 } }>Try again</Button> }>
      { LOAD_ERROR }
    </Alert> }
    { data && <>
      { away && <Typography variant="body2">{ AWAY_LINE }</Typography> }
      <Typography variant="body2" color="text.secondary">{ sectionCaption() }</Typography>
      { lines.length > 0 && <Box component="ul" sx={ { listStyle: 'none', p: 0, m: 0 } }>
        { lines.map(line => <Box component="li" key={ line.id } sx={ { display: 'flex', alignItems: 'center', gap: 1, py: 0.5 } }>
          <Typography variant="body2" sx={ { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }>{ line.text }</Typography>
          { line.review && <Button
            aria-label={ line.review }
            data-review={ line.id }
            onClick={ () => onReview(line.id) }
            sx={ { minHeight: 44, flexShrink: 0 } }>
            { REVIEW }
          </Button> }
        </Box>) }
      </Box> }
      { data.log.length > 0 && <Button onClick={ onShowNotes } sx={ { alignSelf: 'flex-start', px: 0, minHeight: 44 } }>
        { SHOW_NIGHTS }
      </Button> }
    </> }
  </Stack>;
}
