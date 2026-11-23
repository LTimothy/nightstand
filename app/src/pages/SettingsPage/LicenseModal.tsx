import { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, ListItemButton, ListItemText } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import MarkdownBody from '@components/MarkdownBody';
import license from '../../../../LICENSE.md?raw';

export default function LicenseModal() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ListItemButton onClick={ () => setOpen(true) } sx={ { px: 0 } }>
        <ListItemText primary="View license and disclaimer" /><ChevronRightIcon color="action" />
      </ListItemButton>
      <Dialog open={ open } onClose={ () => setOpen(false) } aria-labelledby="license-title" fullWidth maxWidth="md">
        <DialogTitle id="license-title">License and disclaimer</DialogTitle>
        <DialogContent dividers>
          <MarkdownBody markdown={ license }/>
        </DialogContent>
        <DialogActions>
          <Button onClick={ () => setOpen(false) }>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
