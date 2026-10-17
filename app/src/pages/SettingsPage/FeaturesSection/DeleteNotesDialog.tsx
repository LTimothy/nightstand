import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Dialog, DialogActions, DialogTitle } from '@mui/material';
import { postSuggestionsForget } from '@api/rhythms';
import { INACTIVE } from '../../SchedulePage/rhythms/sheetStyles';
import { DELETE_NOTES, DELETE_NOTES_ERROR, DELETE_NOTES_QUESTION } from '../../SchedulePage/rhythms/suggestionsCopy';

type Props = { onClose: () => void };

// Deletes both sides' notes; it works with the feature off, so nothing is left behind after turning it off.
export default function DeleteNotesDialog({ onClose }: Props) {
  const titleId = useId();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await postSuggestionsForget();
      await queryClient.invalidateQueries({ queryKey: ['useSuggestions'] });
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }
    onClose();
  };
  return <Dialog open onClose={ onClose } aria-labelledby={ titleId }>
    <DialogTitle id={ titleId }>{ DELETE_NOTES_QUESTION }</DialogTitle>
    { failed && <Alert severity="error" sx={ { mx: 3 } }>{ DELETE_NOTES_ERROR }</Alert> }
    <DialogActions>
      <Button onClick={ onClose } sx={ { minHeight: 44 } }>Cancel</Button>
      <Button color="error" variant="contained" aria-disabled={ busy } onClick={ () => void remove() } sx={ { minHeight: 44, ...INACTIVE } }>
        { DELETE_NOTES }
      </Button>
    </DialogActions>
  </Dialog>;
}
