import { test as base, expect, chromium } from '@playwright/test';
import path from 'node:path';

export const test = base.extend({
  extension: async ({}, use, testInfo) => {
    const directory = path.resolve(process.env.CROPCLIP_TEST_EXTENSION_DIR || 'dist');
    const context = await chromium.launchPersistentContext('', {
      channel: process.env.CROPCLIP_TEST_BROWSER || 'chromium',
      headless: true,
      args: [`--load-extension=${directory}`, `--disable-extensions-except=${directory}`],
    });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.addInitScript(() => {
      const live = new Set();
      window.testObjectUrls = live;
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); live.add(url); return url; };
      URL.revokeObjectURL = url => { live.delete(url); revoke(url); };
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const page = await context.newPage();
      await page.route('https://chzzk.naver.com/**', route => route.fulfill({
        contentType: 'text/html',
        body: `<body style="margin:0;height:2000px">
          <div class="chzzk_player" style="width:800px;height:400px">
            <video style="width:800px;height:400px;display:block"></video>
            <div class="pzp-pc__bottom"><div class="pzp-pc__bottom-buttons-right"><button class="pzp-button">Native</button></div></div>
          </div><input aria-label="chat">
        </body>`,
      }));
      await page.goto('https://chzzk.naver.com/extension-test');
      await expect(page.locator('#crop-clip-chzzk-tool-button')).toBeAttached();
      await worker.evaluate(() => chrome.storage.local.set({ settings: { enableShortcuts: true, enableFullRecordButton: true } }));
      await expect(page.locator('#crop-clip-chzzk-record-button')).toBeVisible();
      await use({ context, worker, page });
      expect(errors, 'uncaught extension/page exceptions').toEqual([]);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const trace = testInfo.outputPath('trace.zip');
        await context.tracing.stop({ path: trace });
        await testInfo.attach('trace', { path: trace, contentType: 'application/zip' });
      } else await context.tracing.stop();
      await context.close();
    }
  },
});

export { expect };

export async function expectResultResourcesReleased(page, urlCount) {
  await expect.poll(() => page.workers().length, { message: 'conversion workers must terminate after each job' }).toBe(0);
  await expect(page.locator('video')).toHaveCount(1); // Only the visible preview remains.
  await expect.poll(() => page.evaluate(() => window.testObjectUrls.size), { message: 'temporary media/download URLs must be revoked' }).toBe(urlCount);
}

export async function prepareVideo(page, width = 640, height = 360) {
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.evaluate(async ({ width, height }) => {
    await VideoEncoder.isConfigSupported({ codec: 'vp8', width, height, hardwareAcceleration: 'prefer-hardware' });
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    let painting = true;
    const paint = () => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = `hsl(${performance.now() / 20 % 360} 90% 50%)`;
      ctx.fillRect(0, 0, width, height);
      if (painting) requestAnimationFrame(paint);
    };
    paint();
    const audio = new AudioContext();
    await audio.resume();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start();
    const stream = canvas.captureStream(30);
    stream.addTrack(destination.stream.getAudioTracks()[0]);
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 3000));
    recorder.stop();
    await stopped;
    painting = false;
    stream.getTracks().forEach(track => track.stop());
    oscillator.stop();
    await audio.close();
    const video = document.querySelector('video');
    video.src = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
    video.loop = true;
    await video.play().catch(error => { throw new Error(`${error.message}; source ${recorder.mimeType}, ${chunks.map(chunk => chunk.size)}`); });
  }, { width, height });
}

export async function interceptDownloads(page) {
  await page.evaluate(() => {
    window.testDownloads = [];
    HTMLAnchorElement.prototype.click = function () {
      window.testDownloads.push(fetch(this.href).then(response => response.blob()));
    };
  });
}

export async function decodeDownloads(page, maxDuration = Number.MAX_VALUE) {
  return page.evaluate(async maxDuration => {
    const blobs = await Promise.all(window.testDownloads.splice(0));
    return Promise.all(blobs.map(async blob => {
      const video = document.createElement('video');
      video.muted = true;
      const url = URL.createObjectURL(blob);
      video.src = url;
      try {
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Split output cannot decode')); });
        return blob.size > 0 && video.videoWidth > 0 && video.duration > 0 && video.duration < maxDuration;
      } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
    }));
  }, maxDuration);
}
