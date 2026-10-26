import { test, expect } from './fixtures.mjs';
import fs from 'node:fs/promises';

test.skip(!process.env.CROPCLIP_STARTUP_REPORT, 'Opt-in first-recording frame timing');

test('first recording frame timing', async ({ extension }) => {
  test.setTimeout(90_000);
  const { worker, page } = extension;
  const regionMode = process.env.CROPCLIP_STARTUP_MODE === 'region';
  if (regionMode) await worker.evaluate(() => {
    const region = { x: 400, y: 200, width: 400, height: 200, videoRelative: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };
    return chrome.storage.local.set({ region, regions: [region] });
  });
  const button = page.locator(regionMode ? '.crop-clip-border .record-region' : '#crop-clip-chzzk-record-button');
  // Generate this source with recording-profile.spec.mjs first; encoding it in this
  // browser would warm the encoder and invalidate the first-start measurement.
  const source = await fs.readFile('node_modules/.cache/cropclip-profile-source.webm');
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.evaluate(async bytes => {
    const video = document.querySelector('video');
    video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
    video.loop = true;
    await video.play();
    const frames = window.__startupFrames = [];
    const tick = now => { frames.push(now); video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  }, Array.from(source));
  const samples = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.waitForTimeout(1500); // Sample normal playback before each start.
    const start = await page.evaluate(() => performance.now());
    await page.keyboard.press(regionMode ? 'r' : 'e');
    await expect(button).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
    await expect(button).toHaveAttribute('data-recording', '');
    await page.waitForTimeout(2000); // Include encoder startup and the first checkpoint.
    samples.push(await page.evaluate(({ cycle, start }) => {
      const frames = window.__startupFrames;
      const gaps = frames.slice(1).map((time, index) => ({ time, gap: time - frames[index] }));
      const baseline = gaps.filter(frame => frame.time >= start - 1000 && frame.time < start);
      const startup = gaps.filter(frame => frame.time >= start);
      return { cycle, baselineMaxGap: Math.max(...baseline.map(frame => frame.gap)),
        startupMaxGap: Math.max(...startup.map(frame => frame.gap)) };
    }, { cycle, start }));
    await page.keyboard.press('c');
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
    await expect(page.locator('#crop-clip-chzzk-record-button')).toHaveAttribute('aria-busy', 'false');
  }
  await fs.writeFile(process.env.CROPCLIP_STARTUP_REPORT, JSON.stringify({ mode: regionMode ? 'region' : 'full', samples }, null, 2));
  console.log(JSON.stringify(samples));
  // Keep the actual failure visible when explicitly running this diagnostic.
  for (const sample of samples) {
    expect(Number.isFinite(sample.baselineMaxGap) && Number.isFinite(sample.startupMaxGap), 'both intervals must contain video frames').toBe(true);
  }
  expect(samples[0].startupMaxGap, 'the first recording must not stall playback for 200ms').toBeLessThan(200);
});
