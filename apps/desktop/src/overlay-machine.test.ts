import { act, renderHook } from '@testing-library/react';
import { setNativeOverlayMode } from './platform/native';
import { overlayReducer, useOverlayMachine } from './overlay-machine';

vi.mock('./platform/native', () => ({
  setNativeOverlayMode: vi.fn(() => Promise.resolve()),
}));

describe('overlay interaction state', () => {
  it('opens only from an explicit event and closes deterministically', () => {
    expect(overlayReducer('collapsed', { type: 'OPEN' })).toBe('pinned');
    expect(overlayReducer('collapsed', { type: 'SHOW_PREVIEW' })).toBe('preview');
    expect(overlayReducer('preview', { type: 'OPEN' })).toBe('pinned');
    expect(overlayReducer('pinned', { type: 'CLOSE' })).toBe('collapsed');
  });

  it('has no pointer-enter or pointer-leave transition API', () => {
    const { result } = renderHook(() => useOverlayMachine('collapsed'));

    expect(result.current.mode).toBe('collapsed');
    expect(result.current).not.toHaveProperty('onPointerEnter');
    expect(result.current).not.toHaveProperty('onPointerLeave');
  });

  it('opens on click intent and closes on Escape', () => {
    const { result } = renderHook(() => useOverlayMachine('collapsed'));

    act(() => result.current.open());
    expect(result.current.mode).toBe('pinned');

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(result.current.mode).toBe('collapsed');
  });

  it('accepts an authoritative native mode without echoing it back', () => {
    const setNativeMode = vi.mocked(setNativeOverlayMode);
    setNativeMode.mockClear();
    const { result } = renderHook(() => useOverlayMachine('collapsed'));
    expect(setNativeMode).toHaveBeenCalledWith('collapsed');
    setNativeMode.mockClear();

    act(() => result.current.synchronizeNativeMode('preview'));
    expect(result.current.mode).toBe('preview');
    expect(setNativeMode).not.toHaveBeenCalled();

    act(() => result.current.open());
    expect(setNativeMode).toHaveBeenCalledWith('pinned');
  });
});
