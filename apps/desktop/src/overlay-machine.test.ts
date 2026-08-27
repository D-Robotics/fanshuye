import { act, renderHook } from '@testing-library/react';
import { setNativeOverlayMode } from './platform/native';
import { overlayReducer, useOverlayMachine } from './overlay-machine';

vi.mock('./platform/native', () => ({
  setNativeOverlayMode: vi.fn(() => Promise.resolve()),
}));

describe('overlay interaction state', () => {
  it('supports collapsed, preview, pinned, and escape-equivalent unpin transitions', () => {
    expect(overlayReducer('collapsed', { type: 'HOVER_DELAY_ELAPSED' })).toBe('preview');
    expect(overlayReducer('preview', { type: 'PIN' })).toBe('pinned');
    expect(overlayReducer('pinned', { type: 'LEAVE_DELAY_ELAPSED' })).toBe('pinned');
    expect(overlayReducer('pinned', { type: 'UNPIN' })).toBe('collapsed');
  });

  it('does not expand when the pointer leaves before the delay', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOverlayMachine('collapsed', 300, 500));
    act(() => {
      result.current.onPointerEnter();
      result.current.onPointerLeave();
      vi.advanceTimersByTime(400);
    });
    expect(result.current.mode).toBe('collapsed');
    vi.useRealTimers();
  });

  it('delays expansion and keeps the preview pinned after click', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOverlayMachine('collapsed', 300, 500));
    act(() => {
      result.current.onPointerEnter();
      vi.advanceTimersByTime(301);
    });
    expect(result.current.mode).toBe('preview');
    act(() => result.current.pin());
    act(() => {
      result.current.onPointerLeave();
      vi.advanceTimersByTime(700);
    });
    expect(result.current.mode).toBe('pinned');
    vi.useRealTimers();
  });

  it('cancels pending hover work when the window becomes hidden', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ activityEnabled }) => useOverlayMachine('collapsed', 300, 500, activityEnabled),
        { initialProps: { activityEnabled: true } },
      );
      act(() => result.current.onPointerEnter());
      rerender({ activityEnabled: false });
      act(() => vi.advanceTimersByTime(1_000));

      expect(result.current.mode).toBe('collapsed');
      act(() => result.current.onPointerEnter());
      act(() => vi.advanceTimersByTime(1_000));
      expect(result.current.mode).toBe('collapsed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an authoritative native mode without echoing it back', () => {
    vi.useFakeTimers();
    const setNativeMode = vi.mocked(setNativeOverlayMode);
    setNativeMode.mockClear();
    try {
      const { result } = renderHook(() => useOverlayMachine('collapsed', 300, 500));
      expect(setNativeMode).toHaveBeenCalledWith('collapsed');
      setNativeMode.mockClear();

      act(() => result.current.onPointerEnter());
      act(() => result.current.synchronizeNativeMode('preview'));
      expect(result.current.mode).toBe('preview');
      expect(setNativeMode).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1_000));
      expect(result.current.mode).toBe('preview');

      act(() => result.current.pin());
      expect(setNativeMode).toHaveBeenCalledWith('pinned');
    } finally {
      vi.useRealTimers();
    }
  });
});
