import type { SuggestionsResponse } from '@api/rhythmsSchema';
import { getSettings } from './mockData';
import { getMockRhythmsResponse } from './rhythmsMock';

// The demo has no notes yet: an empty Suggestions section while the feature and Rhythms are on.
export function getMockSuggestions(): SuggestionsResponse {
  const enabled = !!getSettings().features.rhythmSuggestions && getMockRhythmsResponse().status.active;
  return { enabled, nights: {}, suggestions: [], dismissed: [], log: [] };
}
