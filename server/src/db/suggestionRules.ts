// WARNING! - Any changes here MUST be the same between app/src/api & server/src/db/
// The rules for Suggestions from your changes. The app renders every number in its copy from here.

export const MIN_NIGHTS = 5;
export const MIN_SHARE = 0.5;
export const HIDE_SHARE = 0.4;
export const NEAR_MIN_NIGHTS = 7;
export const NEAR_MIN_SUPPORT = 3;
export const NEAR_SHARE = 0.4;
export const WINDOW_NIGHTS = 14;
export const COALESCE_MIN = 10;
export const CLUSTER_MIN = 120;
export const ON_WINDOW_MIN = 15;
export const REPLACE_MIN = 30;
export const TIME_ROUND_MIN = 15;
export const MAX_SUGGESTIONS = 3;
export const BASE_STEP = 1;
export const SNOOZE_NIGHTS = 14;
export const NOTE_DAYS = 90;

export const SUGGESTION_RULES = {
  MIN_NIGHTS, MIN_SHARE, HIDE_SHARE, NEAR_MIN_NIGHTS, NEAR_MIN_SUPPORT, NEAR_SHARE, WINDOW_NIGHTS,
  COALESCE_MIN, CLUSTER_MIN, ON_WINDOW_MIN, REPLACE_MIN, TIME_ROUND_MIN, MAX_SUGGESTIONS, BASE_STEP, SNOOZE_NIGHTS, NOTE_DAYS,
} as const;

export type SuggestionRules = { readonly [K in keyof typeof SUGGESTION_RULES]: number };
