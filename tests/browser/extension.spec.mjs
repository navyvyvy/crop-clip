import { test as base, expect, chromium } from '@playwright/test';
import path from 'node:path';

const test = base.extend({
  extension: async ({}, use, testInfo) => {
    const directory = path.resolve('dist');
    const context = await chromium.launchPersistentContext('', {
      channel: process.env.CROPCLIP_TEST_BROWSER || 'chromium',
      headless: true,
      args: [`--load-extension=${directory}`, `--disable-extensions-except=${directory}`],
    });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
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

test('missing and malformed settings recover in the popup and player', async ({ extension }) => {
  const { context, worker, page } = extension;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await expect(popup.locator('input[name="shortcut-mode"][value="on"]')).toBeChecked();
  await worker.evaluate(() => chrome.storage.local.remove('settings'));
  await expect(popup.locator('input[name="shortcut-mode"][value="off"]')).toBeChecked();
  await expect(page.locator('#crop-clip-chzzk-record-button')).toHaveCount(0);
  await worker.evaluate(() => chrome.storage.local.set({ settings: {
    enable60fps: 'false', enableFullRecordButton: true, enableSeek: true, seekSeconds: 999,
    shortcutKeys: { regionRecord: 7, fullRecord: 'E', cancelRecording: {} },
  } }));
  await expect(popup.locator('input[name="fps-mode"][value="off"]')).toBeChecked();
  await expect(popup.locator('#seek-seconds-input')).toHaveValue('60');
  await expect(page.locator('#crop-clip-chzzk-record-button')).toBeVisible();
  await page.reload(); // Initial state and storage updates use the same normalization.
  await expect(page.locator('#crop-clip-chzzk-record-button')).toBeVisible();
  await expect(popup.locator('#custom-video-bitrate-input')).toHaveValue('6');
});

test('delayed starts preserve stop/cancel intent and respond immediately', async ({ extension }) => {
  const { worker, page } = extension;
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' }))[0].id);
  // The UI and event handlers are real; hold only the recording command reply.
  const content = (func, args = []) => worker.evaluate(`(async () => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: (${String(func)}), args: ${JSON.stringify(args)} });
    return result.result;
  })()`);
  await content(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__cropClipTest = { commands: [], replies: [], errors: [] };
    window.alert = message => window.__cropClipTest.errors.push(message);
    chrome.runtime.sendMessage = (message, callback) => {
      if (['START_RECORDING', 'START_FULL_RECORDING', 'STOP_RECORDING', 'CANCEL_RECORDING'].includes(message.type)) {
        window.__cropClipTest.commands.push(message.type);
        window.__cropClipTest.replies.push(callback);
      } else return original(message, callback);
    };
  });
  await worker.evaluate(() => chrome.storage.local.set({ regions: [{ x: 100, y: 100, width: 400, height: 200 }] }));
  await expect(page.locator('.crop-clip-border .record-region')).toBeVisible();
  for (const [key, code, start, selector] of [
    ['e', 'KeyE', 'START_FULL_RECORDING', '#crop-clip-chzzk-record-button'],
    ['r', 'KeyR', 'START_RECORDING', '.crop-clip-border .record-region'],
  ]) {
    for (const terminal of ['STOP_RECORDING', 'CANCEL_RECORDING']) {
      await content(() => { window.__cropClipTest.commands = []; });
      await page.keyboard.press(key);
      const button = page.locator(selector);
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(button).toHaveAttribute('aria-label', /시작 중/);
      await page.evaluate(code => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code, bubbles: true })), code);
      if (terminal === 'CANCEL_RECORDING') await page.keyboard.press('c');
      expect(await content(() => window.__cropClipTest.commands)).toEqual([start]);
      await content(() => window.__cropClipTest.replies.shift()({ ok: true }));
      await expect.poll(() => content(() => window.__cropClipTest.commands)).toEqual([start, terminal]);
      await expect(button).toHaveAttribute('aria-label', terminal === 'STOP_RECORDING' ? /저장 중/ : /취소 중/);
      await content(() => window.__cropClipTest.replies.shift()({ ok: true }));
      await expect(button).toHaveAttribute('aria-busy', 'false');
    }
  }
  const button = page.locator('#crop-clip-chzzk-record-button');
  await content(() => { window.__cropClipTest.commands = []; });
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await content(() => window.__cropClipTest.replies.shift()({ ok: true }));
  // Deliberately delay this physical click; this is the regression stimulus, not a readiness wait.
  await page.evaluate(() => { const end = performance.now() + 700; while (performance.now() < end) {} });
  await page.mouse.up();
  expect(await content(() => window.__cropClipTest.commands)).toEqual(['START_FULL_RECORDING']);
  await button.focus();
  await page.keyboard.press('Enter');
  await content(() => window.__cropClipTest.replies.shift()({ ok: false, error: 'expected failure' }));
  await expect(button).toHaveAttribute('aria-busy', 'false');
  await expect(button).toHaveAttribute('aria-label', /녹화 시작/);
  await page.getByRole('textbox', { name: 'chat' }).fill('typing');
  await page.keyboard.press('e');
  expect(await content(() => window.__cropClipTest.commands)).toHaveLength(2);
  expect(await content(() => window.__cropClipTest.errors)).toEqual(['expected failure']);
});

test('borders follow scrolling, replacement videos and mini-player transitions', async ({ extension }) => {
  const { worker, page } = extension;
  await worker.evaluate(() => chrome.storage.local.set({ regions: [{
    x: 100, y: 100, width: 400, height: 200,
    videoRelative: { x: 0.125, y: 0.25, width: 0.5, height: 0.5 },
  }] }));
  const border = page.locator('.crop-clip-border');
  await expect(border).toBeVisible();
  const expectAligned = async () => {
    await expect.poll(() => page.evaluate(() => {
      const v = document.querySelector('video').getBoundingClientRect();
      const b = document.querySelector('.crop-clip-border').getBoundingClientRect();
      const x = v.x + v.width * 0.125, y = v.y + v.height * 0.25;
      const left = Math.max(0, x), top = Math.max(0, y);
      const expected = [left, top, Math.min(innerWidth, x + v.width * 0.5) - left, Math.min(innerHeight, y + v.height * 0.5) - top];
      return [b.x, b.y, b.width, b.height].every((value, index) => Math.abs(value - expected[index]) < 1);
    })).toBe(true);
  };
  await expectAligned();
  await page.evaluate(() => { const video = document.querySelector('video'); video.replaceWith(video.cloneNode(true)); });
  // Allow the old observer's removal callback to run before resizing the new element.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator('video').evaluate(video => { video.style.width = '640px'; video.style.height = '360px'; });
  await expectAligned();
  await page.evaluate(() => scrollTo(0, 200));
  await expectAligned();
  await page.locator('video').evaluate(video => { video.style.cssText = 'position:fixed;right:20px;bottom:20px;width:320px;height:180px'; });
  await expectAligned();
  await page.evaluate(() => { window.detachedVideo = document.querySelector('video'); window.detachedVideo.remove(); });
  await expect(border).toBeHidden();
  await page.evaluate(() => document.querySelector('.chzzk_player').prepend(window.detachedVideo));
  await expectAligned();
  await page.evaluate(() => { scrollTo(0, 0); document.querySelector('video').style.cssText = 'width:800px;height:400px;display:block'; });
  await expectAligned();
});

test('real repeated recordings survive mini-player moves and split into playable files', async ({ extension }) => {
  test.setTimeout(180_000);
  const { context, worker, page } = extension;
  const dialogs = [];
  const collectDialogs = target => target.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  context.on('page', collectDialogs);
  collectDialogs(page);
  // Play a generated file like the site's media player. A srcObject capture shares
  // its input source in Chromium, so stopping its captured track also ends that source.
  // CropClip's recorder, checkpoint storage and FFmpeg are unmocked.
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.evaluate(async () => {
    await VideoEncoder.isConfigSupported({ codec: 'vp8', width: 640, height: 360, hardwareAcceleration: 'prefer-hardware' });
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    let painting = true;
    const paint = () => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = `hsl(${performance.now() / 20 % 360} 90% 50%)`;
      ctx.fillRect(0, 0, 640, 360);
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
  });
  await worker.evaluate(() => {
    const region = { x: 100, y: 100, width: 400, height: 200,
      videoRelative: { x: 0.125, y: 0.25, width: 0.5, height: 0.5 } };
    return chrome.storage.local.set({ region, regions: [region] });
  });

  let result;
  for (const [index, key] of ['e', 'r', 'e'].entries()) {
    await page.bringToFront();
    await expect.poll(() => page.locator('video').evaluate(video => video.readyState >= 2 && !video.seeking)).toBe(true);
    await page.keyboard.press(key);
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState?.status)).toBe('recording');
    // These waits provide actual recording time, not UI readiness delays.
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      history.pushState({}, '', '/search?query=test');
      const video = document.querySelector('video');
      video.remove();
      document.querySelector('.chzzk_player').append(video);
      video.style.cssText = 'position:fixed;right:20px;bottom:20px;width:320px;height:180px';
    });
    await page.waitForTimeout(4000);
    expect(await worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState?.status)).toBe('recording');
    const opened = context.waitForEvent('page');
    await page.keyboard.press(key);
    result = await opened;
    await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30_000 });
    await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0 && video.duration > 5)).toBe(true);
    expect(dialogs).toEqual([]);
    await page.evaluate(() => {
      history.pushState({}, '', '/extension-test');
      document.querySelector('video').style.cssText = 'width:800px;height:400px;display:block';
    });
    if (index < 2) await result.close();
  }
  // Intercept only the final download, leaving the actual split output intact for decoding.
  await result.evaluate(() => {
    window.testDownloads = [];
    HTMLAnchorElement.prototype.click = function () {
      window.testDownloads.push(fetch(this.href).then(response => response.blob()));
    };
  });
  for (const trimmed of [false, true]) {
    if (trimmed) {
      await result.locator('#trim-start-input').fill('1.3');
      await result.locator('#trim-start-input').press('Tab');
      await result.locator('#trim-end-input').fill('5.3');
      await result.locator('#trim-end-input').press('Tab');
    }
    for (const count of [2, 3, 4]) {
      await result.locator('#split-format-select').selectOption('webm');
      await result.locator(count === 2 ? '[data-split-ratio="0.5"]' : `[data-split-count="${count}"]`).click();
      await result.locator('#split-button').click();
      await expect(result.locator('#split-result-summary')).toHaveText(`나눈 파일 (${count}개)`, { timeout: 30_000 });
      await expect(result.locator('#split-button')).toBeEnabled();
      for (const button of await result.locator('#split-files-list button').all()) await button.click();
      const decoded = await result.evaluate(async () => {
        const blobs = await Promise.all(window.testDownloads.splice(0));
        return Promise.all(blobs.map(async blob => {
          const video = document.createElement('video');
          video.muted = true;
          const url = URL.createObjectURL(blob);
          video.src = url;
          try {
            await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Split output cannot decode')); });
            return blob.size > 0 && video.videoWidth > 0 && video.duration > 0;
          } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
        }));
      });
      expect(decoded).toEqual(Array(count).fill(true));
      expect(dialogs).toEqual([]);
    }
  }
});
