import { useQuery } from '@tanstack/react-query';
import axios from './api';

export const useOtherSlotSupported = () => useQuery<{ supported: boolean | null }>({
  queryKey: ['otherSlot'],
  queryFn: async ({ signal }) => (await axios.get<{ supported: boolean | null }>('/otherSlot', { signal })).data,
});
