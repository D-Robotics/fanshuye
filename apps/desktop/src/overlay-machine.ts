import { useCallback, useEffect, useRef, useState } from 'react';
import { setNativeOverlayMode } from './platform/native';

export type OverlayMode = 'collapsed' | 'preview' | 'pinned';
export type OverlayEvent =
  | { type: 'HOVER_DELAY_ELAPSED' }
  | { type: 'LEAVE_DELAY_ELAPSED' }
  | { type: 'PIN' }
  | { type: 'UNPIN' };

export function overlayReducer(mode: OverlayMode, event: OverlayEvent): OverlayMode {
  switch (event.type) {
    case 'HOVER_DELAY_ELAPSED':
      return mode === 'collapsed' ? 'preview' : mode;
    case 'LEAVE_DELAY_ELAPSED':
      return mode === 'preview' ? 'collapsed' : mode;
    case 'PIN':
      return 'pinned';
    case 'UNPIN':
      return 'collapsed';
  }
}

export interface OverlayMachine {
  mode: OverlayMode;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  pin: () => void;
  unpin: () => void;
  synchronizeNativeMode: (mode: OverlayMode) => void;
}

export function useOverlayMachine(
  initialMode: OverlayMode = 'collapsed',
  expandDelayMs = 320,
  collapseDelayMs = 520,
  activityEnabled = true,
): OverlayMachine {
  const [mode, setMode] = useState(initialMode);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const synchronizedNativeMode = useRef<OverlayMode | null>(null);

  const clearTimer = (timer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const onPointerEnter = useCallback(() => {
    clearTimer(collapseTimer);
    if (!activityEnabled || mode !== 'collapsed') return;
    clearTimer(expandTimer);
    expandTimer.current = setTimeout(() => {
      setMode((current) => overlayReducer(current, { type: 'HOVER_DELAY_ELAPSED' }));
    }, expandDelayMs);
  }, [activityEnabled, expandDelayMs, mode]);

  const onPointerLeave = useCallback(() => {
    clearTimer(expandTimer);
    if (!activityEnabled || mode !== 'preview') return;
    clearTimer(collapseTimer);
    collapseTimer.current = setTimeout(() => {
      setMode((current) => overlayReducer(current, { type: 'LEAVE_DELAY_ELAPSED' }));
    }, collapseDelayMs);
  }, [activityEnabled, collapseDelayMs, mode]);

  const pin = useCallback(() => {
    clearTimer(expandTimer);
    clearTimer(collapseTimer);
    setMode((current) => overlayReducer(current, { type: 'PIN' }));
  }, []);

  const unpin = useCallback(() => {
    clearTimer(expandTimer);
    clearTimer(collapseTimer);
    setMode((current) => overlayReducer(current, { type: 'UNPIN' }));
  }, []);

  const synchronizeNativeMode = useCallback((requestedMode: OverlayMode) => {
    clearTimer(expandTimer);
    clearTimer(collapseTimer);
    synchronizedNativeMode.current = requestedMode;
    setMode(requestedMode);
  }, []);

  useEffect(() => {
    if (synchronizedNativeMode.current === mode) {
      synchronizedNativeMode.current = null;
      return;
    }
    synchronizedNativeMode.current = null;
    void setNativeOverlayMode(mode);
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && mode === 'pinned') unpin();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, unpin]);

  useEffect(() => {
    if (activityEnabled) return;
    clearTimer(expandTimer);
    clearTimer(collapseTimer);
  }, [activityEnabled]);

  useEffect(
    () => () => {
      clearTimer(expandTimer);
      clearTimer(collapseTimer);
    },
    [],
  );

  return { mode, onPointerEnter, onPointerLeave, pin, unpin, synchronizeNativeMode };
}
