import { useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useRef } from 'react';
import { create } from 'zustand';
import moment from 'moment-timezone';

import { useSettings } from '@api/settings.ts';
import { useEventStream } from '@api/eventStream.ts';
import { useSwapCount } from '@api/swapSides.ts';

export type Side = 'left' | 'right';

type AppState = {
  isUpdating: boolean;
  setIsUpdating: (isUpdating: boolean) => void;
  side: Side;
  setSide: (side: Side) => void;
};

const SIDE_KEY = 'side';
const SWAPS_SEEN_KEY = 'sideSwapsSeen';

// A phone that last saw a different swap count by an odd number now holds the other person's side.
// No stored count reads as 0: every recorded swap happened after a phone first chose its side.
export const swapFlipsSide = (seen: number, count: number) => Math.abs(count - seen) % 2 === 1;


// Create Zustand store
export const useAppStore = create<AppState>((set) => ({
  isUpdating: false,
  setIsUpdating: (isUpdating: boolean) => set({ isUpdating }),
  side: localStorage.getItem(SIDE_KEY) as Side || 'left',
  setSide: (side: Side) => {
    set({ side });
    try { localStorage.setItem(SIDE_KEY, side); } catch { /* storage off: the side holds until reload */ }
  },
}));

// Keeps this phone on the same person when the two sides swap, wherever the swap was pressed.
function useFollowSideSwaps() {
  const queryClient = useQueryClient();
  const { data } = useSwapCount();
  const count = data?.count;
  useEffect(() => {
    if (count === undefined) return;
    let seen: number;
    // Without a saved count every poll would flip again, so flip only once it is stored.
    try {
      seen = Number(localStorage.getItem(SWAPS_SEEN_KEY));
      localStorage.setItem(SWAPS_SEEN_KEY, String(count));
    } catch {
      return;
    }
    if (swapFlipsSide(seen, count)) {
      const { side, setSide } = useAppStore.getState();
      setSide(side === 'left' ? 'right' : 'left');
      // Names and schedules in the cache are from before the swap.
      void queryClient.invalidateQueries();
    }
  }, [count, queryClient]);
  // Another tab that flipped already stored the count, so this one follows its saved side.
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key !== SIDE_KEY || (event.newValue !== 'left' && event.newValue !== 'right')) return;
      if (useAppStore.getState().side === event.newValue) return;
      useAppStore.setState({ side: event.newValue });
      void queryClient.invalidateQueries();
    };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, [queryClient]);
}

// Menu options live in a portal and unmount when the menu closes. The control
// worth returning to is the one that opened the menu.
function stableFocusTarget(active: HTMLElement) {
  const popup = active.closest('[role="listbox"], [role="menu"]');
  if (!popup?.id) return active;
  const trigger = document.querySelector(`[aria-controls~="${CSS.escape(popup.id)}"]`);
  return trigger instanceof HTMLElement ? trigger : active;
}

// Controls disable themselves while a save is in flight, and a browser drops
// focus from an element that becomes disabled. That leaves a keyboard user at
// the top of the page after every toggle. Remember what had focus when a
// keyboard-driven save began and give it back once controls are enabled
// again, unless the user moved on or clicked elsewhere in the meantime.
function useRestoreFocusAfterSave() {
  const isUpdating = useAppStore(state => state.isUpdating);
  const focusBeforeSave = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let usingKeyboard = false;
    const onKeyDown = () => { usingKeyboard = true; };
    const onPointerDown = () => {
      usingKeyboard = false;
      focusBeforeSave.current = null;
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (!state.isUpdating || previous.isUpdating) return;
      const active = document.activeElement;
      focusBeforeSave.current = usingKeyboard && active instanceof HTMLElement && active !== document.body ? stableFocusTarget(active) : null;
    });
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (isUpdating) return;
    const target = focusBeforeSave.current;
    focusBeforeSave.current = null;
    if (!target) return;
    // A closing menu keeps focus until it unmounts, so wait for focus to land
    // on the page body; anywhere else means the user has moved on.
    let frames = 0;
    let frame = 0;
    const restore = () => {
      const active = document.activeElement;
      if (!target.isConnected || target.matches(':disabled')) return;
      if (!active || active === document.body) {
        target.focus({ preventScroll: true });
      } else if (active.closest('[role="listbox"], [role="menu"]') && frames++ < 40) {
        frame = requestAnimationFrame(restore);
      }
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [isUpdating]);
}

// AppStoreProvider to sync Zustand with react-query's isFetching
export function AppStoreProvider({ children }: React.PropsWithChildren) {
  // One WebSocket for the whole app, pushing device-status/service-health
  // updates straight into the React Query cache. Mounted at the tree root so
  // there's no per-page connection churn.
  useEventStream();
  useFollowSideSwaps();
  useRestoreFocusAfterSave();
  const { data: settings } = useSettings();

  useEffect(() => {
    if (!settings) return;
    moment.tz.setDefault(settings.timeZone);
  }, [settings]);

  return <>{ children }</>;
}
