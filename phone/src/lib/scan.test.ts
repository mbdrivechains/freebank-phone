import { afterEach, describe, expect, it, vi } from 'vitest';

// A camera that hands out one stream, and a video element that plays it.
function fakeCamera() {
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
  const video = { srcObject: null, muted: false, setAttribute() {}, play: async () => {} } as unknown as HTMLVideoElement;
  return { track, getUserMedia, video };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('jsqr');
  vi.resetModules();
});

describe('the camera', () => {
  it('is not asked for when the reader does not load', async () => {
    vi.doMock('jsqr', () => {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/jsQR.js');
    });
    const { startScan } = await import('./scan');
    const cam = fakeCamera();
    await expect(startScan(cam.video, () => {}, () => false)).rejects.toThrow(); // vitest wraps the load error
    expect(cam.getUserMedia).not.toHaveBeenCalled();
  });

  it('turns off when the scan was left while it started', async () => {
    const { startScan, ScanCancelled } = await import('./scan');
    const cam = fakeCamera();
    let left = false;
    cam.getUserMedia.mockImplementation(async () => {
      left = true; // Cancel tapped while the phone asked for the camera
      return { getTracks: () => [cam.track] };
    });
    await expect(startScan(cam.video, () => {}, () => left)).rejects.toBeInstanceOf(ScanCancelled);
    expect(cam.track.readyState).toBe('ended');
  });

  it('turns off when stopped', async () => {
    const { startScan } = await import('./scan');
    const cam = fakeCamera();
    const stop = await startScan(cam.video, () => {}, () => false);
    expect(cam.track.readyState).toBe('live');
    stop();
    expect(cam.track.readyState).toBe('ended');
    expect(cam.video.srcObject).toBeNull();
  });
});
