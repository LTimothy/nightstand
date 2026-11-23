import { Button, Snackbar } from '@mui/material';
import { palette } from '@design/tokens';

type Props = { message: string; disabled: boolean; onUndo: () => void; onClose: () => void };

// Weekday and date picks save at once; this is the way back from a mis-tap. It stays until dismissed or replaced.
export default function UndoBar({ message, disabled, onUndo, onClose }: Props) {
  return <Snackbar
    open
    key={ message }
    onClose={ (_event, reason) => { if (reason !== 'clickaway') onClose(); } }
    message={ message }
    action={ <Button onClick={ onUndo } disabled={ disabled } sx={ { color: palette.accent, minHeight: 44 } }>Undo</Button> }
    anchorOrigin={ { vertical: 'bottom', horizontal: 'center' } }
    sx={ {
      bottom: { xs: 'calc(72px + env(safe-area-inset-bottom, 0px))', md: 24 },
      left: { xs: 16, sm: '50%' }, right: { xs: 16, sm: 'auto' },
      '& .MuiSnackbarContent-root': {
        bgcolor: palette.bg.raised, color: palette.text.primary, border: `1px solid ${palette.border.medium}`,
        borderRadius: '24px', flexWrap: 'nowrap', minWidth: { sm: 360 },
      },
      '& .MuiSnackbarContent-message': { overflowWrap: 'anywhere', minWidth: 0 },
    } }/>;
}
