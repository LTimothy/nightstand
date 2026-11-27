import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, ButtonBase, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Stack, Typography,
} from '@mui/material';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { swapSides } from '@api/swapSides';
import { useSettings } from '@api/settings.ts';
import { isConflict, serverMessage } from '@lib/requestError';
import { useAppStore } from '@state/appStore.tsx';

type Side = 'left' | 'right';
const DEFAULT_NAME: Record<Side, string> = { left: 'Left', right: 'Right' };

// A default name stays with its side, so an unnamed side is described by its settings.
const moveLine = (name: string | undefined, from: Side, to: Side) => name && (
  <Typography>
    { name === DEFAULT_NAME[from] ? `The ${from} side's settings move` : <><bdi>{ name }</bdi> moves</> } to the { to } side.
  </Typography>
);

export default function SwapSidesButton() {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const { side, setSide } = useAppStore();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<{ text: string; refused: boolean }>();

  const close = () => {
    setOpen(false);
    setError(undefined);
  };
  const swap = async () => {
    setWorking(true);
    setError(undefined);
    try {
      await swapSides(queryClient);
      // This device keeps showing the same person.
      setSide(side === 'left' ? 'right' : 'left');
      close();
    } catch (caught) {
      // A refusal is "not now"; anything else may have gone through, so refetch and ask for a check.
      const refused = isConflict(caught);
      if (!refused) void queryClient.invalidateQueries();
      setError({
        text: refused ? serverMessage(caught) ?? 'Could not swap the sides. Try again.'
          : 'Could not confirm the swap. Check the names above before trying again.',
        refused,
      });
    } finally {
      setWorking(false);
    }
  };

  return (
    // The dialog is a sibling of the row, so its clicks do not bubble into the row's handler.
    <>
      <ButtonBase
        onClick={ () => setOpen(true) }
        sx={ {
          display: 'flex', alignItems: 'center', gap: 1.5, textAlign: 'left', justifyContent: 'flex-start',
          width: '100%', minHeight: 44, px: 0, py: 1.5, mb: -1.5, borderRadius: 1,
          '&:hover': { backgroundColor: 'action.hover' },
        } }
      >
        <SwapHorizIcon sx={ { color: 'text.secondary' } }/>
        <Stack>
          <Typography>Swap sides</Typography>
          <Typography variant="body2" color="text.secondary">Move each person's settings to the other side</Typography>
        </Stack>
      </ButtonBase>
      <Dialog open={ open } onClose={ working ? undefined : close } aria-labelledby={ titleId }>
        <DialogTitle id={ titleId }>Swap sides?</DialogTitle>
        <DialogContent>
          { moveLine(settings?.left.name, 'left', 'right') }
          { moveLine(settings?.right.name, 'right', 'left') }
          <DialogContentText sx={ { mt: settings ? 2 : 0 } }>
            Names, schedules, rhythms, alarms, tap and button settings move to the other side. Past nights follow each
            person on the Sleep page. Sensor calibration stays with each side.
          </DialogContentText>
          <DialogContentText sx={ { mt: 1 } }>
            Other phones keep their selected side, so pick your name there again. Swap before getting into bed, so
            tonight's night is filed under the right name. If a schedule is running tonight, each side turns back on
            with its new settings.
          </DialogContentText>
          { error && <Alert severity={ error.refused ? 'warning' : 'error' } sx={ { mt: 2 } }>{ error.text }</Alert> }
        </DialogContent>
        <DialogActions>
          <Button onClick={ close } disabled={ working }>Cancel</Button>
          <Button onClick={ () => void swap() } disabled={ working } variant="contained">{ working ? 'Swapping...' : 'Swap' }</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
