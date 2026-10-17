import { isAxiosError } from 'axios';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import SectionHeading from '@components/SectionHeading';
import type { useSuggestions } from '@api/rhythms';
import type { SideRhythms } from '@api/rhythmsSchema';
import { AWAY_LINE, LOAD_ERROR, reasonLine, SECTION_TITLE, sectionCaption } from './suggestionsCopy';

type Props = {
  sideData: SideRhythms;
  suggestions: Pick<ReturnType<typeof useSuggestions>, 'data' | 'error' | 'isError' | 'refetch'>;
  away: boolean;
  onShowNotes: () => void;
};

// How counting is going for each rhythm, after the rhythms themselves. An older Pod without the route shows nothing.
export default function SuggestionsSection({ sideData, suggestions, away, onShowNotes }: Props) {
  const { data, error, isError, refetch } = suggestions;
  if (isAxiosError(error) && error.response?.status === 404) return null;
  if (data && !data.enabled) return null;
  const lines = data ? Object.values(sideData.rhythms).flatMap(rhythm => {
    const nights = data.nights[rhythm.id];
    const line = nights ? reasonLine(rhythm.name, nights, rhythm.temperatureMode) : null;
    return line ? [{ id: rhythm.id, line }] : [];
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
        { lines.map(({ id, line }) => <Typography key={ id } component="li" variant="body2" sx={ { py: 0.5, overflowWrap: 'anywhere' } }>
          { line }
        </Typography>) }
      </Box> }
      { data.log.length > 0 && <Button onClick={ onShowNotes } sx={ { alignSelf: 'flex-start', px: 0, minHeight: 44 } }>
        Show the nights
      </Button> }
    </> }
  </Stack>;
}
