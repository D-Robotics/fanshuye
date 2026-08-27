import { useCallback, useEffect, useRef, useState } from 'react';
import { setNativeOverlayMode } from './platform/native';

export type OverlayMode = 'collapsed' | 'preview' | 'pinned';
export type OverlayEvent = { type: 'OPEN' } | { type: 'SHOW_PREVIEW' } | { type: 'CLOSE' };

export function overlayReducer(mode: OverlayMode, event: OverlayEvent): OverlayMode {
  switch (event.type) {
    case 'OPEN':
      return 'pinned';
    case 'SHOW_PREVIEW':
      return mode === 'collapsed' ? 'preview' : mode;
    case 'CLOSE':
      return 'collapsed';
  }
}

export interface OverlayMachine {
  mode: OverlayMode;
  open: () => void;
  close: () => void;
  synchronizeNativeMode: (mode: OverlayMode) => void;
}

export function useOverlayMachine(initialMode: OverlayMode = 'collapsed'): OverlayMachine {
  const [mode, setMode] = useState(initialMode);
  const synchronizedNativeMode = useRef<OverlayMode | null>(null);

  const open = useCallback(() => {
    setMode((current) => overlayReducer(current, { type: 'OPEN' }));
  }, []);

  const close = useCallback(() => {
    setMode((current) => overlayReducer(current, { type: 'CLOSE' }));
  }, []);

  const synchronizeNativeMode = useCallback((requestedMode: OverlayMode) => {
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
      if (event.key === 'Escape' && mode === 'pinned') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, mode]);

  return { mode, open, close, synchronizeNativeMode };
}
