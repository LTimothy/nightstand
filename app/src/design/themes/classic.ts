import { STEPPED_SCALE } from './stepped';
import type { ThemeTokens } from './types';

// The original free-sleep app's look: Roboto, light blue, grey cards with small corners.
export const classic: ThemeTokens = {
  id: 'classic',
  radius: 4,
  palette: {
    bg: { base: '#010101', elevated: '#1E1E1E', raised: '#232323', selected: '#182129', hover: 'rgba(255,255,255,0.08)' },
    border: {
      subtle: 'rgba(255,255,255,0.12)', control: 'rgba(255,255,255,0.4)', medium: 'rgba(255,255,255,0.12)', accent: 'rgba(144,202,249,0.5)',
    },
    text: {
      primary: '#FFFFFF', secondary: 'rgba(255,255,255,0.7)', tertiary: '#88878C', disabled: 'rgba(255,255,255,0.5)',
      onAccent: 'rgba(0,0,0,0.87)', onError: 'rgba(0,0,0,0.87)',
    },
    accent: '#90CAF9',
    lamp: '#E8EAED',
    ember: '#182129',
    appBar: '#121212',
    dial: {
      trackOff: '#272727', tick: '#2E2E2E', tickMajor: '#4A4A4A', tickZero: '#6E6E6E', tickOff: '#222222', tickMajorOff: '#303030',
      ghostOpacity: 0.22, haloOpacity: 0.4,
    },
    step: { cool: '#6B6B6B', warm: '#6B6B6B', disabled: '#2E2E2E', plan: '#90CAF9' },
    power: { offBg: '#010101', offText: '#90CAF9', offBorder: 'rgba(144,202,249,0.5)', nightBg: '#010101' },
    tile: { selectedBorder: 'rgba(144,202,249,0.7)' },
    status: { ok: '#66BB6A', warn: '#FFA726', error: '#F6574C', info: '#29B6F6' },
    stage: { awake: '#E9E3D5', rem: '#C3B5FF', light: '#8E80F0', deep: '#6A58E6' },
    scale: STEPPED_SCALE,
  },
  type: {
    fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
    font: 'roboto',
    bodyLetterSpacing: 'normal',
    headingWeight: 500,
    mediumWeight: 500,
    numeralWeight: 300,
    numeralTrackingEm: 0,
    controlCase: { textTransform: 'uppercase', letterSpacing: '0.02857em' },
    sectionLabel: { fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase' },
  },
};
