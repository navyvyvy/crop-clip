import { test, expect, prepareVideo, decodeDownloads } from './fixtures.mjs';
import fs from 'node:fs/promises';

async function observeRecordingStartup(worker) {
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const timing = globalThis.cropClipStartupTiming = { probes: [], starts: [] };
      const probe = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = async config => {
        if (!config.codec.startsWith('avc1')) return probe(config);
        const sample = { began: performance.now(), finished: null };
        timing.probes.push(sample);
        try { return await probe(config); }
        finally { sample.finished = performance.now(); }
      };
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        const sample = { began: performance.now(), firstChunk: null };
        timing.starts.push(sample);
        this.addEventListener('dataavailable', event => {
          if (sample.firstChunk === null && event.data.size > 0) sample.firstChunk = performance.now();
        });
        start.apply(this, args);
      };
    } });
  });
}

async function readRecordingStartup(worker) {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: () => globalThis.cropClipStartupTiming,
    });
    return result;
  });
}

test('playing video prepares H.264 once before recording without starting an encoder', async ({ extension }) => {
  const { worker, page } = extension;
  test.skip(!await page.evaluate(() => typeof VideoEncoder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=avc1')),
    'Requires H.264 WebM recording support');
  await observeRecordingStartup(worker);
  await prepareVideo(page);
  await expect.poll(async () => (await readRecordingStartup(worker)).probes[0]?.finished, { timeout: 16000 }).toEqual(expect.any(Number));
  expect((await readRecordingStartup(worker)).starts).toHaveLength(0);

  const button = page.locator('#crop-clip-chzzk-record-button');
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'false');
  await expect(button).toHaveAttribute('data-recording', '');
  const timing = await readRecordingStartup(worker);
  expect(timing.probes).toHaveLength(1);
  expect(timing.starts).toHaveLength(1);
  expect(timing.starts[0].began).toBeGreaterThan(timing.probes[0].finished);
  await page.keyboard.press('c');
  await expect(button).not.toHaveAttribute('data-recording', '');
});

const startupTimingTest = process.env.CROPCLIP_STARTUP_REPORT ? test : test.skip;
startupTimingTest('first recording frame timing', async ({ extension }) => {
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
  const source = await fs.readFile(process.env.CROPCLIP_STARTUP_SOURCE || 'node_modules/.cache/cropclip-profile-source.webm');
  await observeRecordingStartup(worker);
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.evaluate(async encoded => {
    const video = document.querySelector('video');
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    video.loop = true;
    await video.play();
    const frames = window.__startupFrames = [];
    const tick = now => { frames.push(now); video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  }, source.toString('base64'));
  const samples = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    // Give the cold capability check time to finish during ordinary viewing.
    await page.waitForTimeout(cycle === 0 ? 8000 : 1500);
    const start = await page.evaluate(() => performance.now());
    await page.keyboard.press(regionMode ? 'r' : 'e');
    await expect(button).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
    await expect(button).toHaveAttribute('data-recording', '');
    await page.waitForTimeout(2000); // Include encoder startup and the first checkpoint.
    const timing = await readRecordingStartup(worker);
    const recording = timing.starts[cycle];
    const startup = await page.evaluate(start => {
      const frames = window.__startupFrames;
      const gaps = frames.slice(1).map((time, index) => ({ time, gap: time - frames[index] }));
      const baseline = gaps.filter(frame => frame.time >= start - 1000 && frame.time < start);
      const startup = gaps.filter(frame => frame.time >= start);
      return { baselineMaxGap: Math.max(...baseline.map(frame => frame.gap)),
        startupMaxGap: Math.max(...startup.map(frame => frame.gap)) };
    }, start);
    samples.push({
      cycle, ...startup,
      clickToRecorderStart: recording.began - start,
      clickToFirstChunk: recording.firstChunk === null ? null : recording.firstChunk - start,
      probesAfterClick: timing.probes.filter(sample => sample.began >= start && sample.began <= recording.began).length,
      ...(cycle === 0 ? { firstProbe: timing.probes[0] && {
        beganFromClick: timing.probes[0].began - start,
        finishedFromClick: timing.probes[0].finished - start,
      } } : {}),
    });
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

for (const format of ['webm', 'mp4']) test(`full H.264 ${format} recordings exclude a stalled opening and keep short originals`, async ({ extension }, testInfo) => {
  test.setTimeout(120_000);
  const { worker, page, context } = extension;
  await prepareVideo(page);
  test.skip(!await page.evaluate(format => MediaRecorder.isTypeSupported(format === 'webm'
    ? 'video/webm;codecs=avc1'
    : 'video/mp4;codecs="avc1,mp4a.40.2"'), format), 'Requires H.264 recording support');
  await worker.evaluate(async outputFormat => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, outputFormat } });
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        start.apply(this, args);
        window.setTimeout(() => {
          const end = performance.now() + 360;
          while (performance.now() < end) { /* Stall the first capture interval. */ }
        }, 60);
      };
    } });
  }, format);
  const cases = [
    { duration: 5000, status: /끊긴 구간을 제외/, min: 2, max: 4.2 },
    { duration: 1000, min: 0.5, max: 2 },
  ];
  if (format === 'webm') cases.push({ duration: 5000, automatic: true });
  for (const { duration, status, min, max, automatic } of cases) {
    if (automatic) {
      const downloads = testInfo.outputPath('automatic');
      await fs.mkdir(downloads, { recursive: true });
      const session = await context.newCDPSession(page);
      await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      await worker.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, enableAutoDownloadRecording: true } });
      });
    }
    await page.bringToFront();
    await page.keyboard.press('e');
    const button = page.locator('#crop-clip-chzzk-record-button');
    await expect(button).toHaveAttribute('data-recording', '', { timeout: 20000 });
    await expect(button).toHaveAttribute('aria-busy', 'false');
    await page.waitForTimeout(duration);
    const opened = context.waitForEvent('page');
    await page.keyboard.press('e');
    const result = await opened;
    if (automatic) {
      await expect.poll(() => result.isClosed(), { timeout: 35000 }).toBe(true);
      const [download] = await worker.evaluate(() => chrome.downloads.search({ state: 'complete' }));
      expect(download?.filename).toMatch(/\.webm$/);
      const bytes = await fs.readFile(download.filename);
      await page.evaluate(data => {
        window.testDownloads = [new Blob([Uint8Array.from(atob(data), byte => byte.charCodeAt(0))], { type: 'video/webm' })];
      }, bytes.toString('base64'));
      expect(await decodeDownloads(page, 4.2)).toEqual([true]);
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
      continue;
    }
    if (status) await expect(result.locator('#split-status')).toHaveText(status, { timeout: 35000 });
    const video = result.locator('#preview-video');
    await expect.poll(() => video.evaluate(element => element.videoWidth)).toBeGreaterThan(0);
    const saved = await video.evaluate(element => element.duration);
    expect(saved).toBeGreaterThan(min);
    expect(saved).toBeLessThan(max);
    const downloadPromise = result.waitForEvent('download');
    await result.locator('#download-current-button').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().endsWith(`_${Math.max(1, Math.round(saved))}s.${format}`)).toBe(true);
    await result.close();
  }
});
