import { Alert, Paper, Typography } from '@mui/material';
import { useStorage } from '@api/storage.ts';
import { formatBytes } from '../../lib/formatBytes.ts';

const NOT_GIVEN = 'Not given by the chip';
const SPARE: Record<number, string> = {
  1: 'Normal', 2: 'Warning, 80% of spare blocks used', 3: 'Urgent, 90% of spare blocks used',
};

// 1 is 0 to 10% of rated life used, 10 is 90 to 100%, 11 is past it.
const lifeText = (level: number | null) => {
  if (level === null || level < 1 || level > 11) return NOT_GIVEN;
  return level === 11 ? 'Past its rated life' : `${(level - 1) * 10} to ${level * 10}% of rated life used`;
};

export default function FlashHealthPanel() {
  const { data } = useStorage(5 * 60_000);
  const flash = data?.flash;
  if (!flash) return null;
  const worn = (flash.preEolInfo ?? 1) >= 2 || Math.max(flash.lifeTimeA ?? 0, flash.lifeTimeB ?? 0) >= 9;
  return <Paper variant="outlined" sx={ { p: 2 } }>
    <Typography component="h2" variant="h6">Flash memory</Typography>
    <Typography variant="body2" color="text.secondary" sx={ { mb: 1 } }>
      The Pod keeps its software, settings and sensor history on built-in flash memory, which wears a little
      with every write. The memory chip keeps its own estimate in 10% steps. This page only reads it.
    </Typography>
    { worn && <Alert severity="warning" sx={ { mb: 1 } }>
      The flash memory is near the end of its rated life. Keep a copy of anything on the Pod you want to keep.
    </Alert> }
    <Typography>Main storage: { lifeText(flash.lifeTimeB) }</Typography>
    <Typography>Fast area: { lifeText(flash.lifeTimeA) }</Typography>
    <Typography>Spare blocks: { flash.preEolInfo === null ? NOT_GIVEN : SPARE[flash.preEolInfo] ?? NOT_GIVEN }</Typography>
    { flash.writtenBytesPerDay !== null && <Typography>
      Writes since the last restart: about { formatBytes(flash.writtenBytesPerDay) } a day
    </Typography> }
  </Paper>;
}
