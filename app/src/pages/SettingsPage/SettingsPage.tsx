import { useRef, useState, type ReactNode } from 'react';
import semver from 'semver';
import { useLatestVersion } from '@api/useLatestVersion.ts';
import { DeepPartial } from 'ts-essentials';
import { Alert, Box, Button, CircularProgress, Link as MuiLink, List, ListItemButton, ListItemText, Stack, Typography } from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { SETTINGS_CATEGORIES } from './settingsCategories';
import SideSettings from './SideSettings.tsx';
import { SubpageShell } from '../DataPage/Header.tsx';
import { useServices } from '@api/services.ts';
import { useDeviceStatus } from '@api/deviceStatus.ts';
import { useStatusSummary } from '../StatusPage/useStatusSummary';
import { Settings } from '@api/settingsSchema.ts';
import { postSettings, useSettings } from '@api/settings.ts';
import { useAppStore } from '@state/appStore.tsx';
import DailyPriming from './DailyPriming.tsx';
import LicenseModal from './LicenseModal.tsx';
import PrimeControl from './PrimeControl.tsx';
import FeaturesSection from './FeaturesSection/FeaturesSection.tsx';
import Section from './Section.tsx';
import StorageIndicator from './StorageIndicator.tsx';
import MemoryIndicator from './MemoryIndicator.tsx';
import ErrorBoundary from '@components/ErrorBoundary.tsx';
import TimeZoneSelector from './DeviceSettingsSection/TimeZoneSelector.tsx';
import TemperatureFormatSelector from './DeviceSettingsSection/TemperatureFormatSelector.tsx';
import ThemePicker from './ThemePicker.tsx';
import LedBrightnessSlider from './DeviceSettingsSection/LedBrightnessSlider.tsx';
import { friendlyTimeZone } from '../../lib/timeZone';
import DeviceInfo from './DeviceSettingsSection/DeviceInfo.tsx';

export default function SettingsPage() {
  const { data: settings, refetch, isLoading, isError } = useSettings();
  const { setIsUpdating } = useAppStore();
  const pendingSaves = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const { pathname } = useLocation();
  const category = pathname.split('/')[2] ?? '';
  const { data: services } = useServices();
  const { data: device } = useDeviceStatus();
  const latestVersion = useLatestVersion();
  const runningVersion = device?.freeSleep?.version;
  const updateAvailable = runningVersion && latestVersion && semver.valid(runningVersion) && semver.valid(latestVersion)
    && semver.gt(latestVersion, runningVersion);
  const { isError: statusError, attention, keys: statusKeys, coreReady } = useStatusSummary();
  const biometricsEnabled = !!services?.biometrics?.enabled;
  const biometricsInstalled = services?.biometrics?.jobs?.installation?.status === 'healthy';
  const featureSwitches = [biometricsEnabled && settings?.features?.presenceAutoOff,
    biometricsEnabled && settings?.features?.biometricsV2,
    settings?.features?.levelTemps, settings?.features?.oneOffAlarms, biometricsInstalled && biometricsEnabled,
    settings?.features?.coverButtons, settings?.features?.rhythms,
    settings?.features?.metricsRetention, settings?.features?.metricsLowDiskProtection,
    biometricsEnabled && settings?.features?.firmwareTargetReadout,
    biometricsEnabled && settings?.features?.firmwareHealth,
    biometricsEnabled && settings?.features?.tapDiagnostics,
    biometricsEnabled && settings?.features?.coolingWarning];
  const enabledFeatures = featureSwitches.filter(Boolean).length;
  const zone = settings?.timeZone ? friendlyTimeZone(settings.timeZone) : 'Time zone not set';
  const issueCount = attention.length;
  const details: Record<string, ReactNode> = {
    bed: settings
      ? <><bdi>{ settings.left.name }</bdi>, <bdi>{ settings.right.name }</bdi> · { zone }</> : 'Names, away mode, units and priming',
    features: settings && services ? `${enabledFeatures} of ${featureSwitches.length} on` : 'Optional sleep and bed controls',
    versions: runningVersion
      ? `v${runningVersion} · ${updateAvailable ? 'Update available' : latestVersion ? 'Up to date' : 'Updates and recovery'}`
      : 'Updates and recovery',
    device: statusError ? 'Status unavailable' : issueCount ? `${issueCount} items need attention`
      : coreReady ? 'Everything running' : statusKeys.length ? 'Waiting for core services' : 'System status, logs and restart',
  };
  const categories = SETTINGS_CATEGORIES.map(item => ({ ...item, detail: details[item.key] }));
  const selected = category === 'about' ? { title: 'About and license' } : categories.find((item) => item.key === category);
  const updateSettings = (patch: DeepPartial<Settings>) => {
    // Nothing is sent until the current settings are known.
    if (!settings) return Promise.resolve(false);
    setError(null);
    pendingSaves.current += 1;
    setIsUpdating(true);
    return postSettings(patch)
      .then(async () => { await refetch(); return true; })
      .catch(() => {
        setError('Could not save settings. Your previous settings are still active. Try the change again.');
        return false;
      })
      .finally(() => {
        pendingSaves.current -= 1;
        setIsUpdating(pendingSaves.current > 0);
      });
  };

  if (category && !selected) return <Navigate to="/settings" replace />;

  return (
    <SubpageShell title={ selected?.title ?? 'Settings' } backTo={ category ? '/settings' : '' }>
      { error && (
        <Alert severity="error" onClose={ () => setError(null) }>
          { error }
        </Alert>
      ) }
      { isError && (
        <Alert severity="error" action={ <Button onClick={ () => refetch() }>Retry</Button> }>
          Could not load settings.
        </Alert>
      ) }
      { isLoading && category && <CircularProgress aria-label="Loading settings" /> }
      { !selected && (
        <List disablePadding sx={ { bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' } }>
          { categories.map((item) => (
            <ListItemButton
              key={ item.key }
              component={ Link }
              to={ `/settings/${item.key}` }
              sx={ { py: 1.5, borderBottom: 1, borderColor: 'divider', '&:last-child': { borderBottom: 0 } } }
            >
              <ListItemText
                primary={ item.title }
                secondary={ item.detail }
                slotProps={ { secondary: { color: item.key === 'device' && issueCount ? 'warning.main' : 'text.secondary' } } } />
              <ChevronRightIcon color="action" />
            </ListItemButton>
          )) }
        </List>
      ) }
      { !selected && <Button component={ Link } to="/settings/about" sx={ { alignSelf: 'flex-start', px: 2 } }>About and license</Button> }
      { category === 'bed' && (
        <>
          <ErrorBoundary componentName="Side settings">
            <Section>
              <SideSettings side="left" settings={ settings } updateSettings={ updateSettings } />
              <Box sx={ { my: 2, borderTop: 1, borderColor: 'divider' } } />
              <SideSettings side="right" settings={ settings } updateSettings={ updateSettings } />
              <Typography variant="body2" color="text.secondary" sx={ { mt: 2 } }>
                Away mode pauses that side's schedules and mirrors the active side. If both sides are away, neither
                schedule runs.
              </Typography>
            </Section>
          </ErrorBoundary>
          <ErrorBoundary componentName="Bed preferences">
            <Section>
              <Stack spacing={ 3 }>
                <TimeZoneSelector settings={ settings } updateSettings={ updateSettings } />
                <TemperatureFormatSelector settings={ settings } updateSettings={ updateSettings } />
                <ThemePicker />
                <LedBrightnessSlider />
              </Stack>
            </Section>
          </ErrorBoundary>

          <ErrorBoundary componentName="Priming settings">
            <Section title="Priming">
              <DailyPriming settings={ settings } updateSettings={ updateSettings } />
              <PrimeControl />
              <Typography variant="body2" color="text.secondary" sx={ { mt: 2 } }>
                Prime while the bed is empty to help circulate water and clear air.
              </Typography>
            </Section>
          </ErrorBoundary>
        </>
      ) }
      { category === 'features' && (
        <>
          <ErrorBoundary componentName="Features section">
            <FeaturesSection />
          </ErrorBoundary>
        </>
      ) }
      { category === 'device' && (
        <>
          <List disablePadding sx={ { bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' } }>
            { [['system', 'System status'], ['logs', 'Logs']].map(([key, label]) => (
              <ListItemButton key={ key } component={ Link } to={ `/settings/${key}` } sx={ { minHeight: 44 } }>
                <ListItemText primary={ label } secondary={ key === 'system' ? details.device : undefined }/><ChevronRightIcon color="action"/>
              </ListItemButton>
            )) }
          </List>
          <ErrorBoundary componentName="Storage indicator">
            <Section>
              <StorageIndicator />
              <MemoryIndicator />
            </Section>
          </ErrorBoundary>
          <ErrorBoundary componentName="Device info">
            <Section>
              <DeviceInfo />
            </Section>
          </ErrorBoundary>
        </>
      ) }
      { category === 'about' && (
        <Section>
          <Typography sx={ { mb: 2 } }>
            Nightstand is a community project based on{ ' ' }
            <MuiLink href="https://github.com/throwaway31265/free-sleep">free-sleep</MuiLink>.
            It is not affiliated with Eight Sleep.
          </Typography>
          { runningVersion && <Typography sx={ { my: 2 } }>Nightstand v{ runningVersion }</Typography> }
          <LicenseModal />
        </Section>
      ) }
    </SubpageShell>
  );
}
