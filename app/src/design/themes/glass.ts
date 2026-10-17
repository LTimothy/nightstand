import { STEPPED_SCALE } from './stepped';
import type { ThemeTokens } from './types';

// The look of jmew's fork: Geist, a strong blue and large corners, drawn flat.
export const glass: ThemeTokens = {
  id: 'glass',
  radius: 16,
  palette: {
    bg: { base: '#000000', elevated: '#080808', raised: '#141416', selected: '#021529', hover: 'rgba(255,255,255,0.08)' },
    border: { subtle: 'rgba(255,255,255,0.06)', control: 'rgba(255,255,255,0.4)', medium: 'rgba(255,255,255,0.12)', accent: '#0A84FF' },
    text: {
      primary: 'rgba(255,255,255,0.95)', secondary: 'rgba(255,255,255,0.65)', tertiary: 'rgba(255,255,255,0.48)',
      disabled: 'rgba(255,255,255,0.25)', onAccent: 'rgba(0,0,0,0.87)', onError: 'rgba(0,0,0,0.87)',
    },
    accent: '#0A84FF',
    lamp: '#F2F2F2',
    ember: '#021529',
    appBar: '#000000',
    dial: {
      trackOff: '#272727', tick: 'rgba(255,255,255,0.12)', tickMajor: 'rgba(255,255,255,0.25)', tickZero: 'rgba(255,255,255,0.4)',
      tickOff: 'rgba(255,255,255,0.08)', tickMajorOff: 'rgba(255,255,255,0.14)', ghostOpacity: 0.22, haloOpacity: 0.4,
    },
    step: { cool: 'rgba(255,255,255,0.4)', warm: 'rgba(255,255,255,0.4)', disabled: 'rgba(255,255,255,0.12)', plan: '#0A84FF' },
    power: { offBg: '#000000', offText: '#0A84FF', offBorder: '#0A84FF', nightBg: '#000000' },
    tile: { selectedBorder: '#0A84FF' },
    status: { ok: '#30D158', warn: '#FFD60A', error: '#FF453A', info: '#0A84FF' },
    stage: { awake: '#E8EAED', rem: '#7DA6FF', light: '#3B6CD6', deep: '#1F4ED8' },
    scale: STEPPED_SCALE,
  },
  type: {
    fontFamily: '"Geist", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    font: 'geist',
    bodyLetterSpacing: 'normal',
    headingWeight: 600,
    mediumWeight: 500,
    numeralWeight: 200,
    numeralTrackingEm: -0.03,
    controlCase: { textTransform: 'none', letterSpacing: 'normal' },
    sectionLabel: { fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase' },
  },
};
