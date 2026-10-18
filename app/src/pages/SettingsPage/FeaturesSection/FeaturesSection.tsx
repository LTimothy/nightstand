import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import Section from '../Section.tsx';
import RawArchiveRetention from '../DeviceSettingsSection/RawArchiveRetention';
import FeatureToggleRow from './FeatureToggleRow.tsx';
import TurnOnFirst from './TurnOnFirst.tsx';
import DisableRhythmsDialog from './DisableRhythmsDialog.tsx';
import EnableRhythmsDialog from './EnableRhythmsDialog.tsx';
import DeleteNotesDialog from './DeleteNotesDialog.tsx';
import { DELETE_NOTES, FEATURE_TITLE, featureDescription } from '../../SchedulePage/rhythms/suggestionsCopy';
import { Services, useServices, postServices } from '@api/services.ts';
import { useSettings, postSettings } from '@api/settings.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useCalibration } from '@api/calibration.ts';
import { EXPERIMENTAL_ON_THIS_POD, sleepTrackingExperimental } from '@api/sleepTrackingValidation.ts';
import { Settings } from '@api/settingsSchema.ts';
import { useAppStore } from '@state/appStore.tsx';
import { DeepPartial } from 'ts-essentials';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

const BIOMETRICS_ESTIMATES = 'Time in bed and heart rate estimated from the bed\'s sensors. Estimates, not medical measurements.';
const BIOMETRICS_UNCHECKED_MODEL = 'Not checked on this Pod model.';
const NEW_SLEEP_TRACKING_CHECKED = 'Tells the two sides apart with the capacitance sensors. Checked on one Pod 5.';
const child = { pl: 2, borderLeft: 1, borderColor: 'divider' };

export default function FeaturesSection() {
  const [error, setError] = useState<string | null>(null);
  const { data: services, refetch: refetchServices, isLoading: servicesLoading, isError: servicesError } = useServices();
  const { data: settings, refetch: refetchSettings, isLoading: settingsLoading, isError: settingsError } = useSettings();
  const { data: deviceStatus } = useDeviceStatus();
  const { data: calibrationState } = useCalibration();
  const setIsUpdating = useAppStore((state) => state.setIsUpdating);
  const isUpdating = useAppStore((state) => state.isUpdating);
  const [rhythmsDialog, setRhythmsDialog] = useState<'enable' | 'disable'>();
  const [deleteNotes, setDeleteNotes] = useState(false);
  const [rhythmsMessage, setRhythmsMessage] = useState<{ text: string; severity: 'success' | 'warning' }>();
  // A "Turn on Biometrics first" link from another page lands here with a hash; focus follows the scroll.
  const { hash } = useLocation();
  const loaded = !!services && !!settings;
  useEffect(() => {
    const target = hash && loaded ? document.getElementById(hash.slice(1)) : null;
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  }, [hash, loaded]);

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

  const saveSettings = (patch: DeepPartial<Settings>) => {
    setError(null);
    setIsUpdating(true);
    postSettings(patch).then(() => refetchSettings())
      .catch(() => setError('Could not save this change. Try again.'))
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

  const needsBiometrics = !biometricsEnabled && <TurnOnFirst
    parent="Biometrics"
    href="#biometrics"/>;

  return (
    <>
      { error && (
        <Alert severity="error" onClose={ () => setError(null) }>
          { error }
        </Alert>
      ) }
      <Section title="Everyday">
        <Box id="rhythms" tabIndex={ -1 } />
        <FeatureToggleRow
          label="Rhythms (beta)"
          ariaLabel="Rhythms"
          disabled={ isUpdating || !features }
          checked={ features?.rhythms ?? false }
          onChange={ (next) => {
            setRhythmsMessage(undefined);
            setRhythmsDialog(next ? 'enable' : 'disable');
          } }
          description="Plan sleep by day and date, with an optional smart temperature curve. Your weekly schedule is kept."
        />
        <Box sx={ child }>
          <FeatureToggleRow
            label={ FEATURE_TITLE }
            disabled={ isUpdating || features?.rhythmSuggestions === undefined || !features?.rhythms }
            checked={ !!features?.rhythms && !!features?.rhythmSuggestions }
            onChange={ next => updateFeature({ rhythmSuggestions: next }) }
            description={ !features?.rhythms
              ? <TurnOnFirst
                parent="Rhythms"
                href="#rhythms"/>
              : featureDescription() }
          />
          <Button onClick={ () => setDeleteNotes(true) } sx={ { minHeight: 44, px: 0 } }>{ DELETE_NOTES }</Button>
        </Box>
        { rhythmsMessage && <Alert severity={ rhythmsMessage.severity } onClose={ () => setRhythmsMessage(undefined) }>
          { rhythmsMessage.text }
        </Alert> }
        <FeatureToggleRow
          label="One-time alarm"
          disabled={ isUpdating || features?.oneOffAlarms === undefined }
          checked={ features?.oneOffAlarms ?? false }
          onChange={ (next) => updateFeature({ oneOffAlarms: next }) }
          description="Adds a one-time alarm to Schedule, separate from the daily wake-up."
        />
        <FeatureToggleRow
          label="Level temperature display"
          disabled={ isUpdating || features?.levelTemps === undefined }
          checked={ features?.levelTemps ?? false }
          onChange={ (next) => updateFeature({ levelTemps: next }) }
          description="Show the -10 to +10 scale as a temperature option."
        />
      </Section>
      <Section title="Sleep tracking">
        <Box id="biometrics" tabIndex={ -1 } />
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
        { !biometricsInstalled && <Accordion disableGutters>
          <AccordionSummary expandIcon={ <ExpandMoreIcon/> }>How to install</AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2">Run this command over SSH, then enable Biometrics here.</Typography>
            <Box component="code" sx={ { display: 'block', overflowWrap: 'anywhere', my: 1 } }>
                  sh /usr/local/lib/nightstand/live/scripts/enable_biometrics.sh
            </Box>
            <Button
              onClick={ async () => {
                try { await navigator.clipboard.writeText('sh /usr/local/lib/nightstand/live/scripts/enable_biometrics.sh'); }
                catch { setError('Could not copy the command. Select and copy it above.'); }
              } }>Copy command</Button>
          </AccordionDetails>
        </Accordion> }
        <Box sx={ child }>
          { biometricsEnabled && <Box sx={ { my: 2 } }>
            <RawArchiveRetention
              settings={ settings }
              updateSettings={ saveSettings } />
          </Box> }
          <FeatureToggleRow
            label="Presence auto-off"
            disabled={ isUpdating || features?.presenceAutoOff === undefined || !biometricsEnabled }
            checked={ features?.presenceAutoOff ?? false }
            onChange={ (next) => updateFeature({ presenceAutoOff: next }) }
            description={ needsBiometrics || 'Turns a side off after 45 minutes with no one on it, outside scheduled hours and away mode.' }
          />
          <FeatureToggleRow
            label="New sleep tracking (beta)"
            disabled={ isUpdating || features?.biometricsV2 === undefined || !biometricsEnabled }
            checked={ features?.biometricsV2 ?? false }
            onChange={ (next) => updateFeature({ biometricsV2: next }) }
            description={ needsBiometrics || (experimental ? EXPERIMENTAL_ON_THIS_POD : NEW_SLEEP_TRACKING_CHECKED) }
          />
          <FeatureToggleRow
            label="Cooling warning"
            disabled={ isUpdating || features?.coolingWarning === undefined || !biometricsEnabled }
            checked={ features?.coolingWarning ?? false }
            onChange={ next => updateFeature({ coolingWarning: next }) }
            description={ needsBiometrics || 'Warns when the water keeps warming while cooling. Changes nothing on the bed.' }
          />
        </Box>
      </Section>
      <Section title="Storage">
        <FeatureToggleRow
          label="Low-disk protection"
          disabled={ isUpdating || features?.metricsLowDiskProtection === undefined }
          checked={ features?.metricsLowDiskProtection ?? true }
          onChange={ (next) => updateFeature({ metricsLowDiskProtection: next }) }
          description="Below 150 MiB free, deletes the oldest detailed vitals. Keeps 2 nights of detail and every nightly summary."
        />
        <FeatureToggleRow
          label="Prune detail after 30 days"
          disabled={ isUpdating || features?.metricsRetention === undefined }
          checked={ features?.metricsRetention ?? false }
          onChange={ (next) => updateFeature({ metricsRetention: next }) }
          description="Deletes detailed vitals older than 30 days. Summaries, scores and movement stay. Cannot be undone."
        />
      </Section>
      { rhythmsDialog === 'enable' && <EnableRhythmsDialog
        onClose={ () => setRhythmsDialog(undefined) }
        onDone={ text => setRhythmsMessage({ text, severity: 'success' }) }/> }
      { rhythmsDialog === 'disable' && <DisableRhythmsDialog
        onClose={ () => setRhythmsDialog(undefined) }
        onDone={ (text, severity) => setRhythmsMessage({ text, severity }) }/> }
      { deleteNotes && <DeleteNotesDialog onClose={ () => setDeleteNotes(false) }/> }
    </>
  );
}
