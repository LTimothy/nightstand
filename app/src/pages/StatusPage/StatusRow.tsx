import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import moment from 'moment-timezone';
import { ServerStatusKey, StatusInfo } from '@api/serverStatusSchema.ts';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';

import StatusChip from './StatusChip.tsx';
import { postJobs, JobSchema, Jobs } from '@api/jobs.ts';
import { useCalibration } from '@api/calibration.ts';
import { Link } from 'react-router-dom';
import { isConflict } from '@lib/requestError.ts';
import { useId, useState } from 'react';
import { palette, weight } from '@design/tokens';
import { STATUS_META, GENERIC_MEANING, statusName } from './statusMeta.ts';
import CalibrationSubline from './CalibrationSubline.tsx';

type StatusRowProps = {
  statusInfo: StatusInfo;
  job: ServerStatusKey;
  divider: boolean;
};

export default function StatusRow({ job, statusInfo, divider }: StatusRowProps) {
  const titleId = useId();
  const meta = STATUS_META[job];
  const meaning = meta.meaning?.[statusInfo.status] ?? GENERIC_MEANING[statusInfo.status];
  const timestamp = statusInfo.timestamp && moment(statusInfo.timestamp).format('MMM D, h:mm A');
  // @ts-expect-error - JobSchema only covers the subset of status keys that are runnable
  const isRunnable = JobSchema.options.includes(job);
  const { data: calibration } = useCalibration();
  const calibrationSide = job === 'biometricsCalibrationLeft'
    ? 'left'
    : job === 'biometricsCalibrationRight' ? 'right' : null;

  const [request, setRequest] = useState<'idle' | 'pending' | 'accepted' | 'queued' | 'failed'>('idle');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [requestedTimestamp, setRequestedTimestamp] = useState<string>();
  const actionLabel = meta.runLabel ?? `Run ${statusInfo.name}`;
  const newStatus = statusInfo.timestamp !== undefined && statusInfo.timestamp !== requestedTimestamp;
  let feedback: string | undefined;
  if (request === 'failed') feedback = 'Could not start this job. Try again.';
  else if (request === 'pending') feedback = 'Sending request...';
  else if (request === 'queued') feedback = 'Already queued or running.';
  else if (request === 'accepted') {
    if (statusInfo.status === 'started') feedback = 'Running.';
    else if (newStatus && statusInfo.status === 'healthy') feedback = 'Completed, as reported by the server.';
    else if (newStatus && statusInfo.status === 'failed') feedback = `Job failed: ${statusInfo.message || 'Check the logs and try again.'}`;
    else if (newStatus && statusInfo.status === 'waiting_for_data') feedback = 'Waiting for enough sensor data.';
    else feedback = 'Request accepted. Waiting for the server to report progress.';
  }
  const failed = request === 'failed' || (request === 'accepted' && newStatus && statusInfo.status === 'failed');
  const startJob = async () => {
    setConfirmationOpen(false);
    setRequestedTimestamp(statusInfo.timestamp);
    setRequest('pending');
    try {
      await postJobs([job] as Jobs);
      setRequest('accepted');
    } catch (failure) {
      setRequest(isConflict(failure) ? 'queued' : 'failed');
    }
  };

  return (
    <Box sx={ { pt: divider ? 1.5 : 0, pb: 1.5, borderTop: divider ? `1px solid ${palette.border.subtle}` : 'none' } }>
      <Box sx={ { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5 } }>
        <Typography sx={ { fontSize: '1rem', fontWeight: weight.heading, color: palette.text.primary, flex: 1, minWidth: 0 } }>
          { statusName(job, statusInfo) }
        </Typography>
        <StatusChip info={ statusInfo } optional={ job === 'biometricsInstallation' && statusInfo.status === 'not_started' } />
      </Box>

      <Typography sx={ { fontSize: '0.8125rem', color: palette.text.tertiary, mt: 0.5, lineHeight: 1.4 } }>
        { meta.blurb }
      </Typography>

      <Typography
        sx={ {
          fontSize: '0.8125rem',
          color: statusInfo.status === 'failed' ? palette.status.error : palette.text.secondary,
          mt: 0.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        } }
      >
        { statusInfo.status === 'failed' && statusInfo.message
          ? `Error: ${statusInfo.message}`
          : (statusInfo.status === 'healthy' || job === 'bootRescue') && statusInfo.message ? statusInfo.message : meaning }
      </Typography>

      { (job === 'franken' || job === 'express') && <Typography variant="caption" color="text.secondary">{ statusInfo.name }</Typography> }
      { job === 'biometricsInstallation' && statusInfo.status === 'not_started' && (
        <Button component={ Link } to="/settings/features">Set up in Features</Button>
      ) }
      { calibrationSide && <CalibrationSubline view={ calibration?.[calibrationSide] }/> }

      { timestamp && (
        <Typography sx={ { fontSize: '0.75rem', color: palette.text.secondary, mt: 0.5 } }>
          { job === 'express' ? `Started ${timestamp}` : timestamp }
        </Typography>
      ) }

      { isRunnable && (
        <Box sx={ { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1.5, mt: 1 } }>
          <Typography sx={ { fontSize: '0.75rem', color: palette.text.tertiary, flex: 1, lineHeight: 1.4 } }>
            { meta.runHint }
          </Typography>
          <Button
            onClick={ () => calibrationSide ? setConfirmationOpen(true) : void startJob() }
            variant="outlined"
            size="small"
            disabled={ request === 'pending' || ((request === 'accepted' || request === 'queued') && !newStatus)
              || statusInfo.status === 'started' }
            startIcon={ <PlayArrowIcon /> }
            sx={ { flexShrink: 0 } }
          >
            { actionLabel }
          </Button>
        </Box>
      ) }
      { feedback && <Alert role={ failed ? 'alert' : 'status' } severity={ failed ? 'error' : 'info' } sx={ { mt: 1 } }>{ feedback }</Alert> }
      <Dialog aria-labelledby={ titleId } open={ confirmationOpen } onClose={ () => setConfirmationOpen(false) }>
        <DialogTitle id={ titleId }>{ actionLabel }?</DialogTitle>
        <DialogContent>
          Keep the { calibrationSide } side empty before continuing. Manual calibration uses the last
          two hours of sensor data and bypasses the automatic occupancy check. Remove people and pets
          from this side; if it has been occupied recently, wait for an empty stretch first.
        </DialogContent>
        <DialogActions>
          <Button onClick={ () => setConfirmationOpen(false) }>Cancel</Button>
          <Button variant="contained" onClick={ () => void startJob() }>{ actionLabel }</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
