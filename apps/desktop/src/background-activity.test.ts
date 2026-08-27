import appSource from './App.tsx?raw';
import appStyles from './app.css?raw';
import overlaySource from './overlay-machine.ts?raw';
import controllerSource from './sync/controller.ts?raw';
import transportSource from './sync/http-transport.ts?raw';

describe('resident desktop background activity budget', () => {
  it('has no production polling or animation-frame loop to run while hidden', () => {
    const residentRuntime = [appSource, overlaySource, controllerSource, transportSource].join(
      '\n',
    );

    expect(residentRuntime).not.toMatch(/\bsetInterval\s*\(/);
    expect(residentRuntime).not.toMatch(/\brequestAnimationFrame\s*\(/);
  });

  it('binds page visibility to both CSS animation pause and realtime suspension', () => {
    expect(appSource).toContain("document.addEventListener('visibilitychange', updateVisibility)");
    expect(appSource).toContain('controllerRef.current?.setWindowVisible(visible)');
    expect(controllerSource).toContain('this.disconnectRealtime?.()');
    expect(appStyles).toContain('html[data-window-hidden] *');
    expect(appStyles).toContain('animation-play-state: paused !important');
  });
});
