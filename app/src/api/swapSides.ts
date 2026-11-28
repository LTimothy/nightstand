import { useQuery, type QueryClient } from '@tanstack/react-query';
import axios from './api';

// How many times the sides have swapped; an older server answers 404 and nothing follows.
export const useSwapCount = () => useQuery<{ count: number }>({
  queryKey: ['useSwapCount'],
  queryFn: async ({ signal }) => (await axios.get<{ count: number }>('/settings/swap-count', { signal })).data,
  refetchInterval: 30_000,
  retry: false,
});

// Names, schedules, rhythms and the Sleep history all read differently after a swap.
export async function swapSides(queryClient: QueryClient): Promise<void> {
  await axios.post('/settings/swap-sides');
  await queryClient.invalidateQueries();
}
