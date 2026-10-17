import type { ThemeTokens } from './types';

// Warm white on near black, with a continuous scale.
export const lamp: ThemeTokens = {
  id: 'lamp',
  radius: 12,
  palette: {
    bg: { base: '#000000', elevated: '#121518', raised: '#1B2026', selected: '#303232', hover: 'rgba(255,255,255,0.08)' },
    border: { subtle: '#23282E', control: '#646D77', medium: 'rgba(255,255,255,0.12)', accent: 'rgba(233,227,213,0.5)' },
    text: {
      primary: '#E4E7EA', secondary: '#8D9D9A', tertiary: '#848C95', disabled: '#565D65',
      onAccent: 'rgba(0,0,0,0.87)', onError: 'rgba(0,0,0,0.87)',
    },
    accent: '#E9E3D5',
    lamp: '#E9E3D5',
    ember: '#2A251F',
    appBar: '#000000',
    dial: {
      trackOff: '#2A2F35', tick: '#2E3338', tickMajor: '#4E545B', tickZero: '#6E757C', tickOff: '#22262A', tickMajorOff: '#30353A',
      ghostOpacity: 0.22, haloOpacity: 0.4,
    },
    step: { cool: '#3E6A92', warm: '#8F673A', disabled: '#2E3338', plan: '#3E6A92' },
    power: { offBg: '#2A251F', offText: '#E4E7EA', offBorder: '#80786C', nightBg: '#1C1915' },
    tile: { selectedBorder: 'rgba(233,227,213,0.7)' },
    status: { ok: '#6CCB8E', warn: '#E8C95A', error: '#FF7A8A', info: '#A3AAB2' },
    stage: { awake: '#E9E3D5', rem: '#C3B5FF', light: '#8E80F0', deep: '#6A58E6' },
    scale: { kind: 'continuous', stops: [[-10, '#5FA8E8'], [-5, '#8CC3EC'], [0, '#C4C9CE'], [5, '#F2B266'], [10, '#F07B4F']] },
  },
  type: {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    font: 'system',
    bodyLetterSpacing: 'normal',
    headingWeight: 600,
    mediumWeight: 500,
    numeralWeight: 300,
    numeralTrackingEm: -0.03,
    controlCase: { textTransform: 'none', letterSpacing: 'normal' },
    sectionLabel: { fontWeight: 600, letterSpacing: 'normal', textTransform: 'none' },
  },
};
