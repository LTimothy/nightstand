import { useState } from 'react';
import { isAxiosError } from 'axios';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, Link, Typography } from '@mui/material';
import Section from '../Section.tsx';
import RawArchiveRetention from '../DeviceSettingsSection/RawArchiveRetention';
import FeatureToggleRow from './FeatureToggleRow.tsx';
import DisableRhythmsDialog from './DisableRhythmsDialog.tsx';
import EnableRhythmsDialog from './EnableRhythmsDialog.tsx';
import { Services, useServices, postServices } from '@api/services.ts';
import { useSettings, postSettings } from '@api/settings.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useCalibration } from '@api/calibration.ts';
import { EXPERIMENTAL_ON_THIS_POD, sleepTrackingExperimental } from '@api/sleepTrackingValidation.ts';
import { Settings } from '@api/settingsSchema.ts';
import { useAppStore } from '@state/appStore.tsx';
import { DeepPartial } from 'ts-essentials';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

const BIOMETRICS_ESTIMATES = 'Detects time in bed and estimates heart rate from the bed\'s sensors. '
  + 'These are estimates, not medical measurements, and have only been checked on a Pod 5.';
const BIOMETRICS_UNCHECKED_MODEL = 'Not checked on this Pod model. Numbers may be further off than on a Pod 5.';
const COVER_BUTTONS = 'For a Pod 4 hub with a Pod 5 cover, whose firmware ignores short clicks on the cover\'s plus and minus buttons. '
  + 'Each ignored click steps that side by 1 F, 15 to 25 s later, because the firmware writes its log in batches. '
  + 'A Pod 5 hub handles its buttons itself, so this does nothing there.';
const NEW_SLEEP_TRACKING_CHECKED = 'Tells the two sides apart with the bed\'s capacitance sensors, for bed times, '
  + 'the in-bed indicator, auto-off and Smart Schedule; that part has been checked on one Pod 5. '
  + 'Heart rate and breathing use newer estimates.';

export default function FeaturesSection() {
  const [error, setError] = useState<string | null>(null);
  const { data: services, refetch: refetchServices, isLoading: servicesLoading, isError: servicesError } = useServices();
  const { data: settings, refetch: refetchSettings, isLoading: settingsLoading, isError: settingsError } = useSettings();
  const { data: deviceStatus } = useDeviceStatus();
  const { data: calibrationState } = useCalibration();
  const setIsUpdating = useAppStore((state) => state.setIsUpdating);
  const isUpdating = useAppStore((state) => state.isUpdating);
  const [rhythmsDialog, setRhythmsDialog] = useState<'enable' | 'disable'>();
  const [rhythmsMessage, setRhythmsMessage] = useState<{ text: string; severity: 'success' | 'warning' }>();

  const updateServices = (services: DeepPartial<Services>) => {
    setError(null);
    setIsUpdating(true);

    postServices(services)
      .then(() => refetchServices())
      .catch((error) => {
        console.error(error);
        const status = isAxiosError(error) ? error.response?.status : undefined;
        // A 409 says an update, rollback or switch is running.
        const message = status && (status === 409 || (status >= 500 && status < 600)) ? error.response?.data?.error : undefined;
        setError(typeof message === 'string' && message.trim() ? message : 'Could not save this change. Try again.');
      })
      .finally(() => setIsUpdating(false));
  };

  const updateFeature = (features: DeepPartial<Settings['features']>) => {
    setError(null);
    setIsUpdating(true);

    postSettings({ features })
      .then(() => refetchSettings())
      .catch((error) => {
        console.error(error);
        setError('Could not save this change. Try again.');
      })
      .finally(() => setIsUpdating(false));
  };

  if (servicesError || settingsError) return <Alert
    severity="warning"
    action={ <Button onClick={ () => { void refetchServices(); void refetchSettings(); } }>Retry</Button> }>
    Could not load features.
  </Alert>;
  if (servicesLoading || settingsLoading || !services || !settings) return <CircularProgress />;

  // A degraded response (partially written db, a proxy error page, version
  // skew) can arrive with pieces missing. Read every field defensively so the
  // section renders as off and untouchable instead of throwing out of render.
  const features = settings.features;
  const biometricsEnabled = services.biometrics?.enabled ?? false;
  const biometricsInstalled = services.biometrics?.jobs?.installation?.status === 'healthy';
  // Unknown counts as unchecked: the labels show until the Pod proves it is a
  // validated Pod 5.
  const experimental = deviceStatus === undefined || sleepTrackingExperimental(
    deviceStatus.coverVersion, deviceStatus.hubVersion,
    [calibrationState?.left?.capFormat, calibrationState?.right?.capFormat],
  );
  // Biometrics only needs the model: the capacitance format is a New sleep tracking matter.
  const modelUnchecked = deviceStatus === undefined
    || sleepTrackingExperimental(deviceStatus.coverVersion, deviceStatus.hubVersion, []);

  return (
    <Section>
      { error && (
        <Alert severity="error" onClose={ () => setError(null) }>
          { error }
        </Alert>
      ) }
      <Box id="biometrics" />
      <FeatureToggleRow
        label="Biometrics"
        disabled={ isUpdating || !biometricsInstalled }
        checked={ biometricsEnabled }
        onChange={ (next) => updateServices({ biometrics: { enabled: next } }) }
        description={
          biometricsInstalled ? <>
            { BIOMETRICS_ESTIMATES }
            { modelUnchecked && <Box component="span" sx={ { display: 'block', mt: 0.5 } }>{ BIOMETRICS_UNCHECKED_MODEL }</Box> }
          </>
            : 'Not installed. Optional sleep and vital estimates.'
        }
      />
      { biometricsEnabled && <Box sx={ { pl: 2, my: 2, borderLeft: 1, borderColor: 'divider' } }>
        <RawArchiveRetention
          settings={ settings }
          updateSettings={ patch => {
            setError(null);
            setIsUpdating(true);
            postSettings(patch).then(() => refetchSettings())
              .catch(() => setError('Could not save this change. Try again.'))
              .finally(() => setIsUpdating(false));
          } } />
      </Box> }
      { !biometricsInstalled && <Accordion disableGutters>
        <AccordionSummary expandIcon={ <ExpandMoreIcon/> }>How to install</AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2">Run this command over SSH, then enable Biometrics here.</Typography>
          <Box component="code" sx={ { display: 'block', overflowWrap: 'anywhere', my: 1 } }>
                sh /home/dac/free-sleep/scripts/enable_biometrics.sh
          </Box>
          <Button
            onClick={ async () => {
              try { await navigator.clipboard.writeText('sh /home/dac/free-sleep/scripts/enable_biometrics.sh'); }
              catch { setError('Could not copy the command. Select and copy it above.'); }
            } }>Copy command</Button>
        </AccordionDetails>
      </Accordion> }
      <Box sx={ { pl: 2, borderLeft: 1, borderColor: 'divider' } }>
        <FeatureToggleRow
          label="Presence auto-off"
          disabled={ isUpdating || features?.presenceAutoOff === undefined || !biometricsEnabled }
          checked={ features?.presenceAutoOff ?? false }
          onChange={ (next) => updateFeature({ presenceAutoOff: next }) }
          description={
            !biometricsEnabled
              ? <Link href="#biometrics" sx={ { display: 'inline-flex', minHeight: 44, alignItems: 'center' } }>Needs Biometrics</Link>
              : 'Turns a side off after 45 minutes with no one on it. Never during a scheduled on-window or in away mode.'
          }
        />
      </Box>
      <Box sx={ { pl: 2, borderLeft: 1, borderColor: 'divider' } }>
        <FeatureToggleRow
          label="New sleep tracking (beta)"
          disabled={ isUpdating || features?.biometricsV2 === undefined || !biometricsEnabled }
          checked={ features?.biometricsV2 ?? false }
          onChange={ (next) => updateFeature({ biometricsV2: next }) }
          description={
            !biometricsEnabled
              ? <Link href="#biometrics" sx={ { display: 'inline-flex', minHeight: 44, alignItems: 'center' } }>Needs Biometrics</Link>
              : experimental ? EXPERIMENTAL_ON_THIS_POD : NEW_SLEEP_TRACKING_CHECKED
          }
        />
      </Box>
      <FeatureToggleRow
        label="Cooling warning"
        disabled={ isUpdating || features?.coolingWarning === undefined }
        checked={ features?.coolingWarning ?? false }
        onChange={ next => updateFeature({ coolingWarning: next }) }
        description="Warns when measured water keeps warming during cooling demand. Needs Biometrics. Does not change bed operation."
      />
      <FeatureToggleRow
        label="Tap diagnostics"
        disabled={ isUpdating || features?.tapDiagnostics === undefined }
        checked={ features?.tapDiagnostics ?? false }
        onChange={ next => updateFeature({ tapDiagnostics: next }) }
        description="Records button and tap candidates on System status, with export. Needs Biometrics. Does not trigger actions."
      />
      <FeatureToggleRow
        label="Firmware health"
        disabled={ isUpdating || features?.firmwareHealth === undefined }
        checked={ features?.firmwareHealth ?? false }
        onChange={ next => updateFeature({ firmwareHealth: next }) }
        description="Shows selected firmware health messages on System status. Needs Biometrics."
      />
      <FeatureToggleRow
        label="Firmware target"
        disabled={ isUpdating || features?.firmwareTargetReadout === undefined }
        checked={ features?.firmwareTargetReadout ?? false }
        onChange={ next => updateFeature({ firmwareTargetReadout: next }) }
        description="Shows the target reported by firmware on System status. Needs Biometrics."
      />
      <FeatureToggleRow
        label="Low-disk protection"
        disabled={ isUpdating || features?.metricsLowDiskProtection === undefined }
        checked={ features?.metricsLowDiskProtection ?? true }
        onChange={ (next) => updateFeature({ metricsLowDiskProtection: next }) }
        description={ 'On by default. Below 150 MiB free, deletes the oldest detailed vitals in batches until '
          + '16 MiB of database pages can be reused. Keeps at least the last 2 nights of detail. '
          + 'Stops database growth by reusing space; does not shrink the database file. '
          + 'Never deletes nightly summaries, sleep records, scores or movement.' }
      />
      <FeatureToggleRow
        label="Prune detail after 30 days"
        disabled={ isUpdating || features?.metricsRetention === undefined }
        checked={ features?.metricsRetention ?? false }
        onChange={ (next) => updateFeature({ metricsRetention: next }) }
        description={ 'Opt-in, off by default. Deletes detailed vitals older than 30 days. '
          + 'Never deletes nightly summaries, sleep records or scores, and keeps movement. '
          + 'Deleted detail cannot be restored. Turning either switch off stops its future deletions.' }
      />
      <FeatureToggleRow
        label="Level temperature display"
        disabled={ isUpdating || features?.levelTemps === undefined }
        checked={ features?.levelTemps ?? false }
        onChange={ (next) => updateFeature({ levelTemps: next }) }
        description="Show the -10 to +10 scale as a temperature option."
      />
      <FeatureToggleRow
        label="One-time alarm"
        disabled={ isUpdating || features?.oneOffAlarms === undefined }
        checked={ features?.oneOffAlarms ?? false }
        onChange={ (next) => updateFeature({ oneOffAlarms: next }) }
        description="Adds a one-time alarm to Schedule, separate from the daily wake-up."
      />
      <FeatureToggleRow
        label="Cover buttons"
        disabled={ isUpdating || features?.coverButtons === undefined }
        checked={ features?.coverButtons ?? false }
        onChange={ (next) => updateFeature({ coverButtons: next }) }
        description={ COVER_BUTTONS }
      />
      <FeatureToggleRow
        label="Rhythms (beta)"
        ariaLabel="Rhythms"
        disabled={ isUpdating || !features }
        checked={ features?.rhythms ?? false }
        onChange={ (next) => {
          setRhythmsMessage(undefined);
          setRhythmsDialog(next ? 'enable' : 'disable');
        } }
        description={ 'Plan sleep by day and date, with an optional smart temperature curve. '
          + 'Your weekly schedule is kept and comes back if you turn this off.' }
      />
      { rhythmsMessage && <Alert severity={ rhythmsMessage.severity } onClose={ () => setRhythmsMessage(undefined) }>
        { rhythmsMessage.text }
      </Alert> }
      { rhythmsDialog === 'enable' && <EnableRhythmsDialog
        onClose={ () => setRhythmsDialog(undefined) }
        onDone={ text => setRhythmsMessage({ text, severity: 'success' }) }/> }
      { rhythmsDialog === 'disable' && <DisableRhythmsDialog
        onClose={ () => setRhythmsDialog(undefined) }
        onDone={ (text, severity) => setRhythmsMessage({ text, severity }) }/> }
    </Section>
  );
}
