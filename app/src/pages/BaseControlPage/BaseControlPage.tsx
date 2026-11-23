import { useBaseStatus, useSetBasePosition, useSetBasePreset, useStopBase } from '@api/baseControl';
import { Link } from 'react-router-dom';
import BedVisualization from '@components/BedVisualization';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { Alert, Box, Button, CircularProgress, IconButton, Paper, Stack, Typography } from '@mui/material';
import { useAppStore } from '@state/appStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import PageContainer from '../PageContainer';
import BedTabs from '@components/BedTabs';
import PageHeader from '@components/PageHeader';
import { media, weight } from '@design/tokens';
import { BED_MAX_WIDTH, BED_PADDING_X } from '@components/pageRail';

interface BasePosition { head: number; feet: number }
// Same rhythm as Bed, so the tabs stay put when switching between the two.
const pageSx = {
  [media.short]: { gap: 1, pt: 1 },
  [media.tight]: { gap: 0.5, pt: 0.5 },
  [media.desktop]: { maxWidth: BED_MAX_WIDTH, px: BED_PADDING_X, pt: '24px', pb: '40px' },
} as const;
// On a desktop the controls sit in Bed's 440 px left column, under the tabs.
const columnSx = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%',
  [media.desktop]: { maxWidth: 440, alignSelf: 'flex-start' },
} as const;
const presets = {
  flat: { head: 0, feet: 0 },
  sleep: { head: 1, feet: 5 },
  relax: { head: 30, feet: 15 },
  read: { head: 40, feet: 0 },
};

export default function BaseControlPage() {
  const { isUpdating } = useAppStore();
  const { data: baseStatus, dataUpdatedAt, isLoading, isError, isSuccess } = useBaseStatus();
  const [lastCheckFailed, setLastCheckFailed] = useState(false);
  useEffect(() => {
    if (isError) setLastCheckFailed(true);
    else if (isSuccess) setLastCheckFailed(false);
  }, [isError, isSuccess]);
  const statusUnavailable = isError || lastCheckFailed;
  const positionMutation = useSetBasePosition();
  const presetMutation = useSetBasePreset();
  const stopMutation = useStopBase();
  const [position, setPosition] = useState<BasePosition>({ head: 0, feet: 0 });
  const [requested, setRequested] = useState(false);
  const [queued, setQueued] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcile = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const statusRef = useRef(baseStatus);
  statusRef.current = baseStatus;

  // Superseding actions invalidate both the queued move and stale async results.
  const cancelPending = useCallback(() => {
    generation.current += 1;
    if (debounce.current) clearTimeout(debounce.current);
    if (reconcile.current) clearTimeout(reconcile.current);
    debounce.current = null;
    reconcile.current = null;
  }, []);
  useEffect(() => cancelPending, [cancelPending]);

  useEffect(() => {
    if (baseStatus) setPosition({ head: baseStatus.head, feet: baseStatus.feet });
  }, [baseStatus?.head, baseStatus?.feet]);

  useEffect(() => {
    if (baseStatus?.isMoving === false) setStopFailed(false);
  }, [baseStatus?.isMoving, dataUpdatedAt]);

  const reconcileStationary = (token: number) => {
    reconcile.current = setTimeout(() => {
      if (token !== generation.current) return;
      setRequested(false);
      const status = statusRef.current;
      if (status) setPosition({ head: status.head, feet: status.feet });
      setFeedback(status?.isMoving ? '' : 'No movement reported. Position shown is the last reported position.');
    }, 2500);
  };

  const sendPosition = async (next: BasePosition, token: number) => {
    if (token !== generation.current) return;
    setQueued(false);
    try {
      await positionMutation.mutateAsync({ ...next, feedRate: 50 });
      if (token === generation.current) {
        setStopFailed(false);
        reconcileStationary(token);
      }
    } catch {
      if (token !== generation.current) return;
      setRequested(false);
      setError('Could not send the position. Check the connection and try again.');
    }
  };

  const updatePosition = (next: BasePosition) => {
    cancelPending();
    setPosition(next);
    setRequested(true);
    setQueued(true);
    setError('');
    setFeedback('');
    const token = generation.current;
    debounce.current = setTimeout(() => { void sendPosition(next, token); }, 500);
  };

  const handleStop = async () => {
    cancelPending();
    const token = generation.current;
    setQueued(false);
    setError('');
    setRequested(true);
    setFeedback('');
    try {
      await stopMutation.mutateAsync();
      if (token !== generation.current) return;
      setRequested(false);
      setStopFailed(false);
      setFeedback('Stop requested. Check the reported position.');
    } catch {
      if (token !== generation.current) return;
      setRequested(false);
      setStopFailed(true);
      setError('Could not confirm Stop. Try Stop again.');
    }
  };

  const handlePreset = async (preset: keyof typeof presets) => {
    cancelPending();
    const token = generation.current;
    setQueued(false);
    setRequested(true);
    setError('');
    setFeedback('');
    try {
      await presetMutation.mutateAsync(preset);
      if (token === generation.current) {
        setStopFailed(false);
        reconcileStationary(token);
      }
    } catch {
      if (token !== generation.current) return;
      setRequested(false);
      setError('Could not send the preset. Check the connection and try again.');
    }
  };

  const moving = !!baseStatus?.isMoving;
  const showStop = requested || moving || stopFailed;
  const pending = positionMutation.isPending || presetMutation.isPending || stopMutation.isPending;
  const unavailable = isLoading || statusUnavailable || baseStatus?.isConfigured === false || !baseStatus;

  return (
    <PageContainer sx={ pageSx }>
      <PageHeader title="Bed"/>
      <BedTabs/>
      <Box sx={ columnSx }>
        { isLoading && !statusUnavailable && !baseStatus && <CircularProgress size={ 24 } aria-label="Loading base position" /> }
        { statusUnavailable && <Alert severity="error">Could not load the base position.</Alert> }
        { baseStatus?.isConfigured === false && <Alert severity="info">
          No adjustable base found. Pair an adjustable base in Eight Sleep's app before using Elevation.
          <Button component={ Link } to="/" sx={ { display: 'flex', width: 'fit-content', px: 0 } }>Back to Temperature</Button>
        </Alert> }
        { error && <Alert severity="error" sx={ { width: '100%' } }>{ error }</Alert> }
        { baseStatus?.isConfigured !== false && <>
          <Box sx={ { width: '100%', maxWidth: 280 } }>
            <BedVisualization headPosition={ baseStatus?.head ?? 0 } feetPosition={ baseStatus?.feet ?? 0 } />
          </Box>
          <Typography role="status" variant="body2" color="text.secondary" sx={ { minHeight: 21 } }>
            { moving ? 'Base is moving...' : requested ? 'Movement requested. Waiting for feedback.' : feedback }
          </Typography>
          <Stack direction="row" spacing={ 2 } sx={ { width: '100%', justifyContent: 'center' } }>
            { (['head', 'feet'] as const).map(axis => (
              <Box key={ axis } sx={ { textAlign: 'center', minWidth: 0 } }>
                <Typography variant="body2">{ axis === 'head' ? 'Head' : 'Feet' } angle</Typography>
                <Stack direction="row" alignItems="center">
                  <IconButton
                    aria-label={ `Decrease ${axis} angle` }
                    disabled={ unavailable || isUpdating || pending || position[axis] <= 0 }
                    onClick={ () => updatePosition({ ...position, [axis]: Math.max(0, position[axis] - 1) }) }>
                    <RemoveIcon />
                  </IconButton>
                  <Typography sx={ { minWidth: 40, fontSize: '1.5rem', fontWeight: weight.medium, fontVariantNumeric: 'tabular-nums' } }>
                    { position[axis] }°
                  </Typography>
                  <IconButton
                    aria-label={ `Increase ${axis} angle` }
                    disabled={ unavailable || isUpdating || pending || position[axis] >= (axis === 'head' ? 45 : 30) }
                    onClick={ () => updatePosition({ ...position, [axis]: Math.min(axis === 'head' ? 45 : 30, position[axis] + 1) }) }>
                    <AddIcon />
                  </IconButton>
                </Stack>
              </Box>
            )) }
          </Stack>
          <Box sx={ { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1, width: '100%' } }>
            { Object.entries(presets).map(([name, preset]) => {
              const active = baseStatus?.head === preset.head && baseStatus?.feet === preset.feet;
              return <Paper key={ name } variant="outlined" sx={ { borderColor: active ? 'primary.main' : 'divider' } }>
                <Button
                  fullWidth
                  aria-pressed={ active }
                  disabled={ unavailable || isUpdating || pending || moving || (requested && !queued) }
                  onClick={ () => void handlePreset(name as keyof typeof presets) }
                  sx={ { flexDirection: 'column', py: 1.5 } }>
                  <Typography component="span">{ name.charAt(0).toUpperCase() + name.slice(1) }</Typography>
                  <Typography component="span" variant="caption" color="text.secondary">Head { preset.head }°, feet { preset.feet }°</Typography>
                </Button>
              </Paper>;
            }) }
          </Box>
          { showStop && <Button
            variant="contained"
            color="error"
            fullWidth
            // Sticky so a short phone still shows it above the bottom bar while the base moves.
            sx={ { position: 'sticky', bottom: { xs: 'calc(72px + env(safe-area-inset-bottom, 0px))', md: 16 }, zIndex: 1 } }
            onClick={ () => void handleStop() }
            disabled={ stopMutation.isPending }>
            { stopMutation.isPending ? 'Stopping...' : 'Stop movement' }
          </Button> }
        </> }
      </Box>
    </PageContainer>
  );
}
