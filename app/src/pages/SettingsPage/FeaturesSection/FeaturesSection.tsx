import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress, Typography } from '@mui/material';
import Section from '../Section.tsx';
import RawArchiveRetention from '../DeviceSettingsSection/RawArchiveRetention';
import ToggleRow from '@components/ToggleRow';
import TurnOnFirst from './TurnOnFirst.tsx';
import DisableRhythmsDialog from './DisableRhythmsDialog.tsx';
import EnableRhythmsDialog from './EnableRhythmsDialog.tsx';
import DeleteNotesDialog from './DeleteNotesDialog.tsx';
import { DELETE_NOTES, FEATURE_TITLE, featureDescription } from '../../SchedulePage/rhythms/suggestionsCopy';
import { Services, useServices, postServices } from '@api/services.ts';
import { useSettings, postSettings } from '@api/settings.ts';
import { Settings } from '@api/settingsSchema.ts';
import { useAppStore } from '@state/appStore.tsx';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { Version } from '@api/deviceStatusSchema.ts';
import { DeepPartial } from 'ts-essentials';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

const BIOMETRICS_ESTIMATES = 'Time in bed and heart rate estimated from the bed\'s sensors. Estimates, not medical measurements.';
const NEW_SLEEP_TRACKING = 'Tells the two sides apart with the capacitance sensors. '
  + 'It changes the nightly sleep records and the heart rate and breathing estimates.';
const UNCHECKED_CAP_PRESENCE = 'Schedules, auto-off and the in-bed indicator follow capacitance presence once both '
  + 'sides are learned. Checked on one Pod 3.';

export default function FeaturesSection() {
  const [error, setError] = useState<string | null>(null);
  const { data: services, refetch: refetchServices, isLoading: servicesLoading, isError: servicesError } = useServices();
  const { data: settings, refetch: refetchSettings, isLoading: settingsLoading, isError: settingsError } = useSettings();
  const { data: deviceStatus } = useDeviceStatus();
  // A Pod 5 always hears capacitance presence, so its switch would do nothing there.
  const showCapPresence = !!deviceStatus && deviceStatus.hubVersion !== Version.Pod5;
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
        <ToggleRow
          label="Rhythms"
          disabled={ isUpdating || !features }
          checked={ features?.rhythms ?? false }
          onChange={ (next) => {
            setRhythmsMessage(undefined);
            setRhythmsDialog(next ? 'enable' : 'disable');
          } }
          description="Plan sleep by day and date, with an optional Smart Schedule temperature curve. Your weekly schedule is kept.">
          <ToggleRow
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
        </ToggleRow>
        { rhythmsMessage && <Alert
          severity={ rhythmsMessage.severity }
          onClose={ () => setRhythmsMessage(undefined) }
          sx={ { mb: 2 } }>
          { rhythmsMessage.text }
        </Alert> }
        <ToggleRow
          label="One-time alarm"
          disabled={ isUpdating || features?.oneOffAlarms === undefined }
          checked={ features?.oneOffAlarms ?? false }
          onChange={ (next) => updateFeature({ oneOffAlarms: next }) }
          description="Adds a one-time alarm to Schedule, separate from the daily wake-up. Off, a set one-time alarm does not ring."
        />
        <ToggleRow
          label="Ring alarms when the side is off"
          disabled={ isUpdating || features?.alarmsWhenOff === undefined }
          checked={ features?.alarmsWhenOff ?? false }
          onChange={ (next) => updateFeature({ alarmsWhenOff: next }) }
          description="Alarms vibrate even if the side is off."
        />
        { deviceStatus?.hubVersion === Version.Pod5 && <ToggleRow
          label="Show the Pod's target temperatures"
          disabled={ isUpdating || features?.targetTemperatureLabels === undefined }
          checked={ features?.targetTemperatureLabels ?? false }
          onChange={ (next) => updateFeature({ targetTemperatureLabels: next }) }
          description={ 'Shows the Pod 5 firmware\'s own target curve instead of the usual straight-line scale. '
            + 'Schedules are unchanged. No effect in Level format.' }
        /> }
        { deviceStatus?.hubVersion === Version.Pod5 && <ToggleRow
          label="Restart the cover service on its own"
          disabled={ isUpdating || features?.coverAutoRestore === undefined }
          checked={ features?.coverAutoRestore ?? false }
          onChange={ (next) => updateFeature({ coverAutoRestore: next }) }
          description={ 'When one side of the cover sends no readings for 10 minutes, Nightstand restarts the Pod\'s cover service. '
            + 'At most once an hour, never near an alarm.' }
        /> }
      </Section>
      <Section title="Sleep tracking">
        <Box id="biometrics" tabIndex={ -1 } />
        <ToggleRow
          label="Biometrics"
          disabled={ isUpdating || !biometricsInstalled }
          checked={ biometricsEnabled }
          onChange={ (next) => updateServices({ biometrics: { enabled: next } }) }
          description={
            biometricsInstalled ? BIOMETRICS_ESTIMATES : 'Not installed. Optional sleep and vital estimates.'
          }>
          { !biometricsInstalled && <Accordion
            disableGutters
            square
            sx={ { background: 'transparent', boxShadow: 'none', border: 0, '&:before': { display: 'none' } } }
          >
            <AccordionSummary expandIcon={ <ExpandMoreIcon/> } sx={ { px: 0, minHeight: 44 } }>How to install</AccordionSummary>
            <AccordionDetails sx={ { px: 0 } }>
              <Typography variant="body2">Run this command over SSH, then enable Biometrics here.</Typography>
              <Box component="code" sx={ { display: 'block', overflowWrap: 'anywhere', userSelect: 'all', my: 1 } }>
                  sh /usr/local/lib/nightstand/live/scripts/enable_biometrics.sh
              </Box>
            </AccordionDetails>
          </Accordion> }
          { biometricsEnabled && <Box sx={ { mt: 2, mb: 2 } }>
            <RawArchiveRetention
              settings={ settings }
              updateSettings={ saveSettings } />
          </Box> }
          <ToggleRow
            label="Presence auto-off"
            disabled={ isUpdating || features?.presenceAutoOff === undefined || !biometricsEnabled }
            checked={ features?.presenceAutoOff ?? false }
            onChange={ (next) => updateFeature({ presenceAutoOff: next }) }
            description={ needsBiometrics || 'Turns a side off after 45 minutes with no one on it, outside scheduled hours and away mode.' }
          />
          <ToggleRow
            label="New sleep tracking (beta)"
            disabled={ isUpdating || features?.biometricsV2 === undefined || !biometricsEnabled }
            checked={ features?.biometricsV2 ?? false }
            onChange={ (next) => updateFeature({ biometricsV2: next }) }
            description={ needsBiometrics || NEW_SLEEP_TRACKING }>
            { showCapPresence && <ToggleRow
              label="Capacitance presence (beta)"
              disabled={ isUpdating || features?.uncheckedCapPresence === undefined || !biometricsEnabled
                || !features?.biometricsV2 }
              checked={ !!features?.biometricsV2 && !!features?.uncheckedCapPresence }
              onChange={ (next) => updateFeature({ uncheckedCapPresence: next }) }
              description={ needsBiometrics || (!features?.biometricsV2
                ? <TurnOnFirst
                  parent="New sleep tracking"
                  href="#biometrics"/>
                : UNCHECKED_CAP_PRESENCE) }
            /> }
          </ToggleRow>
          <ToggleRow
            label="Cooling warning"
            disabled={ isUpdating || features?.coolingWarning === undefined || !biometricsEnabled }
            checked={ features?.coolingWarning ?? false }
            onChange={ next => updateFeature({ coolingWarning: next }) }
            description={ needsBiometrics || 'Warns when the water keeps warming while cooling. Changes nothing on the bed.' }
          />
        </ToggleRow>
      </Section>
      <Section title="Storage">
        <ToggleRow
          label="Low-disk protection"
          disabled={ isUpdating || features?.metricsLowDiskProtection === undefined }
          checked={ features?.metricsLowDiskProtection ?? true }
          onChange={ (next) => updateFeature({ metricsLowDiskProtection: next }) }
          description={ 'Below 150 MiB free, deletes the oldest detailed vitals, then movement for nights already summarized. '
            + 'Keeps 2 nights of detail and every nightly summary.' }
        />
        <ToggleRow
          label="Delete detail after 30 days"
          disabled={ isUpdating || features?.metricsRetention === undefined }
          checked={ features?.metricsRetention ?? false }
          onChange={ (next) => updateFeature({ metricsRetention: next }) }
          description="Deletes detailed vitals older than 30 days. Summaries, scores and movement stay. Cannot be undone."
        />
        <ToggleRow
          label="Keep the system log in memory"
          disabled={ isUpdating || features?.journalInMemory === undefined }
          checked={ features?.journalInMemory ?? false }
          onChange={ (next) => updateFeature({ journalInMemory: next }) }
          description={ 'Cuts flash writes. Starts at the next Pod restart; the system log then clears on each restart. '
            + 'Nightstand\'s logs are kept. Older system log files on flash are removed after that restart.' }
        />
        <ToggleRow
          label="Write flash less often"
          disabled={ isUpdating || features?.longFlashCommit === undefined }
          checked={ features?.longFlashCommit ?? false }
          onChange={ (next) => updateFeature({ longFlashCommit: next }) }
          description="Fewer flash writes. A power cut can lose up to the last minute of sensor recordings and logs."
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
