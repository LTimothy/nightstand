import type { QueryClient } from '@tanstack/react-query';
import axios from './api';

// Names, schedules, rhythms and the Sleep history all read differently after a swap.
export async function swapSides(queryClient: QueryClient): Promise<void> {
  await axios.post('/settings/swap-sides');
  await queryClient.invalidateQueries();
}
