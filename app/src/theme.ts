import {
  alpha, createTheme, darken, getLuminance, lighten, type Theme, type ThemeOptions, type TypographyVariantsOptions,
} from '@mui/material/styles';

import { themeTokens } from '@design/tokens';
import type { ThemeTokens } from '@design/themes/types';

// Sizes are shared by every look; only colour, corners and type voice come from the tokens.
const buildTypography = ({ type }: ThemeTokens): TypographyVariantsOptions => ({
  fontFamily: type.fontFamily,
  fontWeightMedium: type.mediumWeight,
  allVariants: {
    fontSize: 16,
    letterSpacing: 'normal',
    fontVariantNumeric: 'tabular-nums',
  },
  h1: { fontSize: '1.75rem', fontWeight: type.headingWeight, lineHeight: 1.15, letterSpacing: '-0.01em' },
  h2: { fontSize: '1.125rem', fontWeight: type.headingWeight },
  h3: { fontSize: '1.125rem', fontWeight: type.headingWeight },
  h4: { fontSize: '1rem', fontWeight: type.headingWeight },
  h5: { fontSize: '1rem', fontWeight: type.headingWeight },
  h6: { fontSize: '0.875rem', fontWeight: type.headingWeight },
  body1: { fontSize: '1rem', lineHeight: 1.5, letterSpacing: type.bodyLetterSpacing },
  body2: { fontSize: '0.875rem', lineHeight: 1.5, letterSpacing: type.bodyLetterSpacing },
  caption: { fontSize: '0.8125rem', letterSpacing: type.bodyLetterSpacing },
});

const getFilledChipStyles = (theme: Theme, paletteKey: 'success' | 'info' | 'warning' | 'secondary') => {
  const paletteColor = theme.palette[paletteKey];
  return {
    backgroundColor: alpha(paletteColor.main, 0.35),
    color: paletteColor.light ?? paletteColor.contrastText ?? theme.palette.getContrastText(paletteColor.main),
    border: 'none',
  };
};

const buildComponents = ({ palette: p, radius, type }: ThemeTokens) => {
  const controlCase = { textTransform: type.controlCase.textTransform, letterSpacing: type.controlCase.letterSpacing };
  return {
    MuiCssBaseline: {
      styleOverrides: {
        // Keep a focused control clear of the fixed bars: the bottom navigation
        // below the md breakpoint and the top bar above it.
        html: {
          scrollPaddingBottom: 'calc(64px + env(safe-area-inset-bottom, 0px) + 16px)',
          '@media (min-width: 900px)': { scrollPaddingTop: '80px', scrollPaddingBottom: '16px' },
        },
        summary: { minHeight: 44, paddingBlock: 10, boxSizing: 'border-box', cursor: 'pointer' },
        ':focus-visible': { outline: `2px solid ${p.accent}`, outlineOffset: '3px' },
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
            scrollBehavior: 'auto !important',
          },
        },
      },
    },
    // ButtonBase resets the outline, leaving only a faint focus ripple on
    // buttons, links, tabs and accordions. Match the outline switches and
    // fields already show, and drop the ripple so there is one focus style.
    MuiButtonBase: {
      styleOverrides: {
        root: {
          '&.Mui-focusVisible': { outline: `2px solid ${p.accent}`, outlineOffset: '2px' },
          '&.Mui-focusVisible .MuiTouchRipple-ripplePulsate': { display: 'none' },
        },
      },
    },
    // MUI draws an outlined border at half the label's colour, under 3:1 in some looks; hover keeps the full colour.
    MuiButton: { styleOverrides: { root: { ...controlCase, minHeight: 44, variants: [
      { props: { variant: 'outlined', color: 'primary' }, style: { '--variant-outlinedBorder': p.border.accent } },
      { props: { variant: 'outlined', color: 'secondary' }, style: { '--variant-outlinedBorder': p.border.accent } },
    ] } } },
    MuiSlider: { styleOverrides: { root: { padding: '20px 0' }, thumb: { '&::after': { width: 44, height: 44 } } } },
    MuiSwitch: {
      // The negative margin puts the thumb's outer edge on the content edge, like buttons and text.
      styleOverrides: { root: { width: 64, height: 44, padding: 15, marginRight: -12 }, switchBase: { padding: 12, color: p.text.secondary } },
    },
    MuiRadio: { styleOverrides: { root: { minWidth: 44, minHeight: 44 } } },
    MuiCheckbox: { styleOverrides: { root: { minWidth: 44, minHeight: 44 } } },
    MuiIconButton: { styleOverrides: { root: { minWidth: 44, minHeight: 44 } } },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          ...controlCase,
          minHeight: 44,
          paddingBlock: 8,
          fontSize: 16,
          lineHeight: 1.5,
          '&.Mui-selected': { backgroundColor: p.bg.selected },
        },
      },
    },
    MuiTabs: { styleOverrides: { root: { minHeight: 44 } } },
    MuiTab: { styleOverrides: { root: { ...controlCase, minHeight: 44 } } },
    MuiFormControl: { defaultProps: { variant: 'standard' } },
    MuiCardContent: { styleOverrides: { root: { padding: 16, '&:last-child': { paddingBottom: 16 } } } },
    MuiAccordion: { styleOverrides: { root: {
      '&&': { borderRadius: radius, margin: 0 }, '&:before': { display: 'none' },
    } } },
    MuiAccordionSummary: { styleOverrides: { root: { fontFamily: 'inherit', fontSize: 16, fontWeight: type.mediumWeight, minHeight: 44,
      '&.Mui-expanded': { minHeight: 44 },
      '&.Mui-focusVisible': { outlineOffset: '-2px' } }, content: { margin: '8px 0', '&.Mui-expanded': { margin: '8px 0' } } } },
    MuiDialogTitle: { styleOverrides: { root: { fontSize: 16, fontWeight: type.headingWeight } } },
    // Loading is grey in every look, like the dial's stale state.
    MuiCircularProgress: { styleOverrides: { colorPrimary: { color: p.text.tertiary } } },
    MuiLinearProgress: { styleOverrides: {
      colorPrimary: { backgroundColor: p.border.subtle }, barColorPrimary: { backgroundColor: p.text.tertiary },
    } },
    MuiListItemText: { styleOverrides: { root: { marginBlock: 2 } } },
    MuiListItemButton: { styleOverrides: { root: { minHeight: 44, '&.Mui-focusVisible': { outlineOffset: '-2px' },
      '&.Mui-selected': { backgroundColor: p.bg.selected } } } },
    MuiFormControlLabel: { styleOverrides: { label: { textTransform: 'none' } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none', border: `1px solid ${p.border.subtle}`, boxShadow: 'none' } } },
    MuiTextField: { defaultProps: { variant: 'standard' } },
    MuiCard: { styleOverrides: { root: { textTransform: 'none' } } },
    MuiFormHelperText: { styleOverrides: { root: { fontSize: '0.875rem' } } },
    MuiOutlinedInput: { styleOverrides: { notchedOutline: { borderColor: p.border.control } } },
    MuiInputBase: { styleOverrides: { root: { minHeight: 44 }, input: { minHeight: 44, boxSizing: 'border-box' } } },
    MuiSelect: {
      defaultProps: { variant: 'standard' },
      styleOverrides: {
        select: { minHeight: '44px !important', boxSizing: 'border-box', display: 'flex', alignItems: 'center', fontSize: 16 },
      },
    },
    MuiAutocomplete: { styleOverrides: { input: { fontSize: 16 } } },
    MuiInput: {
      styleOverrides: {
        input: { fontSize: 16 },
        underline: { '&:before': { borderBottomColor: p.border.control } },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          borderTop: 'none',
          borderLeft: 'none',
          borderRight: 'none',
          borderBottomColor: `${p.border.subtle} !important`,
          boxShadow: 'none',
          backgroundColor: p.appBar,
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 999, fontWeight: type.mediumWeight },
        colorSuccess: ({ theme }) => getFilledChipStyles(theme, 'success'),
        colorInfo: ({ theme }) => getFilledChipStyles(theme, 'info'),
        colorWarning: ({ theme }) => getFilledChipStyles(theme, 'warning'),
        colorSecondary: ({ theme }) => getFilledChipStyles(theme, 'secondary'),
      },
    },
  } satisfies ThemeOptions['components'];
};

// A filled button's label is set per look, not left to MUI's 3:1 pick. Its hover fill moves away from the label,
// so the pair keeps its contrast.
const filled = (main: string, label: string) => ({
  main, contrastText: label, dark: getLuminance(label) < 0.5 ? lighten(main, 0.2) : darken(main, 0.3),
});

export const buildMuiTheme = (tokens: ThemeTokens) => {
  const p = tokens.palette;
  return createTheme({
    typography: buildTypography(tokens),
    palette: {
      mode: 'dark',
      divider: p.border.subtle,
      primary: filled(p.accent, p.text.onAccent),
      secondary: filled(p.accent, p.text.onAccent),
      success: { main: p.status.ok },
      warning: { main: p.status.warn },
      error: filled(p.status.error, p.text.onError),
      info: { main: p.status.info },
      action: { active: p.text.secondary, disabled: p.text.disabled, hover: p.bg.hover },
      text: { primary: p.text.primary, secondary: p.text.secondary, disabled: p.text.disabled },
      background: { default: p.bg.base, paper: p.bg.elevated },
    },
    shape: { borderRadius: tokens.radius },
    components: buildComponents(tokens),
  });
};

export const theme = buildMuiTheme(themeTokens);
