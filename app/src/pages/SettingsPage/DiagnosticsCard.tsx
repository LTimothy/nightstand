import { Typography } from '@mui/material';
import { DeepPartial } from 'ts-essentials';
import type { Settings } from '@api/settingsSchema.ts';
import { useServices } from '@api/services.ts';
import { useAppStore } from '@state/appStore.tsx';
import Section from './Section.tsx';
import FeatureToggleRow from './FeaturesSection/FeatureToggleRow.tsx';
import TurnOnFirst from './FeaturesSection/TurnOnFirst.tsx';

const SWITCHES = [
  ['Firmware health', 'firmwareHealth', 'Selected firmware health messages.'],
  ['Firmware target', 'firmwareTargetReadout', 'The target the firmware reports.'],
  ['Tap diagnostics', 'tapDiagnostics', 'Button and tap candidates, with export. Triggers nothing.'],
] as const;

type Props = {
  settings?: Settings;
  updateSettings: (patch: DeepPartial<Settings>) => unknown;
};

// Readouts that only add to System status, so they sit next to its link.
export default function DiagnosticsCard({ settings, updateSettings }: Props) {
  const { isUpdating } = useAppStore();
  const { data: services } = useServices();
  const enabled = services?.biometrics?.enabled;
  const biometricsEnabled = enabled ?? false;
  const features = settings?.features;
  return <Section title="Diagnostics">
    <Typography
      variant="body2"
      color="text.secondary"
      sx={ { mb: 1 } }>Shown on System status.</Typography>
    { SWITCHES.map(([label, flag, description]) => <FeatureToggleRow
      key={ flag }
      label={ label }
      disabled={ isUpdating || features?.[flag] === undefined || !biometricsEnabled }
      checked={ features?.[flag] ?? false }
      onChange={ next => { void updateSettings({ features: { [flag]: next } }); } }
      // Unknown keeps the switch disabled with its plain description; only a known off points to Biometrics.
      description={ enabled === false ? <TurnOnFirst
        parent="Biometrics"
        href="/settings/features#biometrics"/> : description }/>) }
  </Section>;
}
