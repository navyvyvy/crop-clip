import { test, expect, prepareVideo, interceptDownloads, decodeDownloads, expectResultResourcesReleased } from './fixtures.mjs';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

for (const format of ['webm', 'mp4']) {
  test(`${format} stop releases capture immediately while messages and storage are delayed`, async ({ extension }) => {
    test.setTimeout(120_000);
    const { context, worker, page } = extension;
    await prepareVideo(page);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' }))[0].id);
    const content = (func, args = []) => worker.evaluate(`(async () => {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: (${String(func)}), args: ${JSON.stringify(args)} });
      return result.result;
    })()`);
    await content(() => {
      const OriginalRecorder = MediaRecorder;
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__stopTest = { held: [], holdWrites: true, routedStops: 0 };
      window.MediaRecorder = class extends OriginalRecorder {
        constructor(stream, options) {
          super(stream, options);
          window.__stopTest.recorder = this;
          window.__stopTest.tracks = stream.getTracks();
        }
      };
      chrome.runtime.sendMessage = (message, callback) => {
        if (message.type === 'STOP_RECORDING') {
          window.__stopTest.routedStops++;
          return; // Simulate a background command that cannot run under load.
        }
        if (message.type === 'FINALIZE_RECORDING') {
          window.__stopTest.finalize = () => send(message, callback);
          return;
        }
        if (message.type === 'STORE_RECORDING_CHUNK') {
          return send(message, response => {
            if (window.__stopTest.holdWrites) window.__stopTest.held.push(() => callback(response));
            else callback(response);
          });
        }
        return send(message, callback);
      };
    });
    await worker.evaluate(format => {
      const region = { x: 400, y: 200, width: 400, height: 200,
        videoRelative: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };
      return chrome.storage.local.set({ region, regions: [region], settings: {
        enableShortcuts: true, enableFullRecordButton: true, outputFormat: format,
      } });
    }, format);
    for (const mode of ['full', 'region', 'popup']) {
      await page.bringToFront();
      await content(() => { window.__stopTest.holdWrites = true; });
      const selector = mode === 'region' ? '.crop-clip-border .record-region' : '#crop-clip-chzzk-record-button';
      await page.keyboard.press(mode === 'region' ? 'r' : 'e');
      await expect(page.locator(selector)).toHaveAttribute('aria-busy', 'false');
      await expect.poll(() => content(() => window.__stopTest.held.length)).toBeGreaterThan(0);
      let popup;
      if (mode === 'popup') {
        popup = await context.newPage();
        await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
        await popup.evaluate(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (message, ...args) => message.type === 'STOP_RECORDING'
            ? new Promise(() => {}) : send(message, ...args);
        });
        await popup.getByRole('button', { name: '전체 정지', exact: true }).click();
        await expect.poll(() => content(() => window.__stopTest.recorder.state)).toBe('inactive');
      }
      const stopped = await content((mode, selector) => {
        if (mode === 'full') document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true }));
        else if (mode === 'region') document.querySelector(selector).click();
        const { recorder, tracks, routedStops } = window.__stopTest;
        return { state: recorder.state, live: tracks.filter(track => track.readyState === 'live').length, routedStops };
      }, [mode, selector]);
      expect(stopped).toEqual({ state: 'inactive', live: 0, routedStops: 0 });
      if (!popup) await expect(page.locator(selector)).toHaveAttribute('aria-label', /저장 중/);
      await expect(page.locator(mode === 'region' ? '.crop-clip-border .record-time' : '#crop-clip-chzzk-record-time')).toHaveText('저장 중');
      const opened = context.waitForEvent('page');
      await content(() => {
        window.__stopTest.holdWrites = false;
        window.__stopTest.held.splice(0).forEach(reply => reply());
      });
      await expect.poll(() => content(() => Boolean(window.__stopTest.finalize))).toBe(true);
      // The final persistence step can also stall after every checkpoint was saved.
      await expect(page.locator(mode === 'region' ? '.crop-clip-border .record-time' : '#crop-clip-chzzk-record-time')).toHaveText('저장 중');
      await content(() => {
        const finalize = window.__stopTest.finalize;
        window.__stopTest.finalize = null;
        finalize();
      });
      const result = await opened;
      await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30_000 });
      await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState >= 2 && video.duration > 0.5)).toBe(true);
      expect(await result.locator('#preview-video').evaluate(video => [video.videoWidth, video.videoHeight]))
        .toEqual(mode === 'region' ? [320, 180] : [640, 360]);
      await result.locator('#preview-video').evaluate(async video => {
        video.currentTime = Math.max(0, video.duration - 0.2);
        await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject; });
      });
      const pixels = await result.locator('#preview-video').evaluate(video => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0);
        return [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
          .map(([x, y]) => Array.from(context.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data).slice(0, 3));
      });
      const palette = mode === 'region' ? Array(4).fill([255, 255, 0]) : [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
      pixels.forEach((pixel, index) => pixel.forEach((channel, color) => expect(Math.abs(channel - palette[index][color])).toBeLessThan(50)));
      expect(await result.evaluate(async () => {
        const { getPartsByRecordingId } = await import('/shared/idb.js');
        const [part] = await getPartsByRecordingId(new URL(location.href).searchParams.get('id'));
        const audio = new AudioContext();
        try {
          const decoded = await audio.decodeAudioData(await part.blob.arrayBuffer());
          return decoded.duration > 0.5 && decoded.getChannelData(0).some(value => Math.abs(value) > 0.01);
        } finally { await audio.close(); }
      })).toBe(true);
      if (format === 'webm' && mode === 'full') {
        await interceptDownloads(result);
        await result.evaluate(() => {
          window.testReencodes = 0;
          const start = MediaRecorder.prototype.start;
          MediaRecorder.prototype.start = function (...args) { window.testReencodes++; return start.apply(this, args); };
        });
        const mp4 = result.locator('[data-convert-format="mp4"]');
        await mp4.click();
        await expect.poll(() => result.evaluate(() => window.testDownloads.length), { timeout: 30_000 }).toBe(1);
        await expect(mp4).toBeEnabled();
        expect(await result.evaluate(() => window.testReencodes)).toBe(0);
        expect(await decodeDownloads(result)).toEqual([true]);
      }
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
      await result.close();
      await popup?.close();
    }
  });
}

test('screen recording is recovered if a stored checkpoint reply is lost', async ({ extension }) => {
  const { context, worker, page } = extension;
  const alerts = [];
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.dismiss(); });
  await prepareVideo(page);
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => {
        if (message.type !== 'STORE_RECORDING_CHUNK') return send(message, callback);
        return send(message, response => { globalThis.testCheckpointStored = response?.ok === true; });
      };
    } });
    return tab.id;
  });
  await page.keyboard.press('e');
  await expect.poll(() => worker.evaluate(async id => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => globalThis.testCheckpointStored });
    return result.result;
  }, tabId)).toBe(true);
  const opened = context.waitForEvent('page', { timeout: 30_000 });
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
  await expect(page.locator('#crop-clip-chzzk-record-time')).toHaveCount(0);
  expect(alerts).toEqual([]);
});

test('a saved result unlocks recording when the final reply is lost', async ({ extension }) => {
  const { context, worker, page } = extension;
  const alerts = [];
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.dismiss(); });
  await prepareVideo(page);
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => message.type === 'FINALIZE_RECORDING'
        ? send(message, () => {}) : send(message, callback);
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = ms => timeout(ms === 30_000 ? 3_000 : ms);
    } });
  });
  const button = page.locator('#crop-clip-chzzk-record-button');
  await page.keyboard.press('e');
  await expect(page.locator('#crop-clip-chzzk-record-time')).toHaveText(/00:0[2-9]/);
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
  await expect(button).toHaveAttribute('aria-busy', 'false');
  expect(context.pages().filter(tab => tab.url().includes('/result/result.html'))).toHaveLength(1);
  expect(alerts).toEqual([]);
});

test('screen recording is saved if the recorder stop event is lost', async ({ extension }) => {
  const { context, worker, page } = extension;
  await prepareVideo(page);
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      Object.defineProperty(MediaRecorder.prototype, 'onstop', { configurable: true, set() {} });
    } });
  });
  await page.keyboard.press('e');
  const timer = page.locator('#crop-clip-chzzk-record-time');
  await expect(timer).toHaveText(/00:0[2-9]/);
  const opened = context.waitForEvent('page', { timeout: 15_000 });
  await page.keyboard.press('e');
  await expect(timer).toHaveText('저장 중');
  const result = await opened;
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
  await expect(timer).toHaveCount(0);
});

test('recording timers wait for capture and keep size visible after original fallback', async ({ extension }) => {
  const { context, worker, page } = extension;
  await context.addInitScript(() => {
    if (location.pathname !== '/result/result.html') return;
    const ready = new Promise(resolve => { window.resumeResultPreparation = resolve; });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'LOAD') { void ready.then(() => post.call(this, message, ...args)); return; }
      return post.call(this, message, ...args);
    };
  });
  await prepareVideo(page, 1920, 1080, 5200);
  await page.evaluate(() => history.pushState({}, '', '/live/timing-fixture'));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ settings: {
      enableShortcuts: true, enableFullRecordButton: true, enableOriginalStreamRecording: true, showRecordingSize: true,
      customVideoBitsPerSecond: 2_000_000, videoBitsPerSecond: 8_500_000,
    } });
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/live/timing-fixture' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const Recorder = MediaRecorder;
      window.MediaRecorder = class extends Recorder {
        constructor(stream, options) {
          super(stream, options);
          document.documentElement.dataset.fallbackVideoBitrate = `${options.videoBitsPerSecond}/${this.videoBitsPerSecond}`;
          const dataset = document.documentElement.dataset;
          dataset.screenRecorders = String(Number(dataset.screenRecorders ?? '0') + 1);
        }
        start(...args) {
          document.documentElement.dataset.timingRecorderReady = '';
          document.addEventListener('cropclip-test-start', () => super.start(...args), { once: true });
        }
      };
    } });
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = options => {
      if (options.world !== 'MAIN') return execute(options);
      return new Promise(resolve => {
        globalThis.failOriginalProbe = () => {
          chrome.scripting.executeScript = execute;
          resolve([{ result: { ok: false, error: 'Injected original lookup failure' } }]);
        };
      });
    };
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (tabId, message, callback) => {
      if (message.type !== 'START_DIRECT_RECORDING') return send(tabId, message, callback);
      globalThis.releaseCaptureStart = () => {
        chrome.tabs.sendMessage = send;
        return send(tabId, message, callback);
      };
    };
  });
  const playerTime = page.locator('#crop-clip-chzzk-record-time');
  const popupTime = popup.locator('#recording-time');
  await page.bringToFront();
  await page.keyboard.press('e');
  await expect.poll(() => worker.evaluate(() => Boolean(globalThis.releaseCaptureStart))).toBe(true);
  try {
    await expect(popupTime).toHaveText('시작 중');
    await expect(playerTime).toHaveText('시작 중');
    expect(await worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.startedAt)).toBeUndefined();
  } finally {
    await worker.evaluate(() => { globalThis.releaseCaptureStart(); });
  }
  await expect(page.locator('html')).toHaveAttribute('data-timing-recorder-ready', '');
  await expect(page.locator('html')).toHaveAttribute('data-fallback-video-bitrate', '8500000/8500000');
  await page.waitForTimeout(1_100);
  await expect(popupTime).toHaveText('시작 중');
  await expect(playerTime).toHaveText('시작 중');
  await page.evaluate(() => document.dispatchEvent(new Event('cropclip-test-start')));
  const runningWithSize = /^약 (?!0\.0 MB)[\d.]+ MB · (?!00:00)\d+:\d+$/;
  await expect(playerTime).toHaveText(runningWithSize);
  await expect(popupTime).toHaveText(runningWithSize);
  expect(await worker.evaluate(() => Boolean(globalThis.failOriginalProbe))).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-screen-recorders', '1');
  const startedAt = await worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.startedAt);
  await worker.evaluate(() => { globalThis.failOriginalProbe(); });
  const feedback = page.locator('#crop-clip-seek-feedback');
  await expect(feedback).toHaveText(/화면 녹화 중 · WebM\s+Injected original lookup failure/);
  await expect(page.locator('html')).toHaveAttribute('data-screen-recorders', '1');
  await expect(page.locator('html')).toHaveAttribute('data-fallback-video-bitrate', '8500000/8500000');
  expect((await feedback.textContent()).split('\n')).toHaveLength(2);
  await expect(feedback).toHaveCSS('white-space', 'pre-line');
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.startedAt)).toBe(startedAt);
  expect(await playerTime.evaluate(el => getComputedStyle(el).color)).toBe(
    await playerTime.evaluate(el => getComputedStyle(el.parentElement).color));
  for (const showRecordingSize of [false, true]) {
    await worker.evaluate(async showRecordingSize => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, showRecordingSize } });
    }, showRecordingSize);
    const expected = showRecordingSize ? /^약 [\d.]+ MB · \d+:\d+$/ : /^\d+:\d+$/;
    await expect(playerTime).toHaveText(expected);
    await expect(popupTime).toHaveText(expected);
  }
  for (const timer of [playerTime, popupTime]) {
    await expect.poll(() => timer.evaluate((element, start) => {
      const match = /(\d+):(\d+)$/.exec(element.textContent);
      if (!match) return Infinity;
      const displayed = Number(match[1]) * 60 + Number(match[2]);
      return Math.abs(displayed - Math.floor((Date.now() - start) / 1_000));
    }, startedAt)).toBeLessThanOrEqual(1);
  }
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  try {
    const saved = await result.evaluate(async () => {
      const { getPartsByRecordingId, getRecording } = await import('/shared/idb.js');
      const id = new URL(location.href).searchParams.get('id');
      const [part] = await getPartsByRecordingId(id);
      const recording = await getRecording(id);
      const date = new Date(recording.createdAt);
      const pad = value => String(value).padStart(2, '0');
      const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
      return { createdAt: recording.createdAt, captureMethod: part.captureMethod, extension: part.extension, size: part.blob.size,
        videoBitsPerSecond: part.videoBitsPerSecond, filename: part.filename, timestamp };
    });
    expect(saved).toMatchObject({ createdAt: startedAt, captureMethod: 'screen', extension: 'webm', videoBitsPerSecond: 8_500_000 });
    expect(saved.size).toBeGreaterThan(0);
    expect(saved.filename).toBe(`cropClip_${saved.timestamp}.webm`);
  } finally {
    await result.evaluate(() => window.resumeResultPreparation());
  }
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30_000 });
  await expect(result.locator('#preview-video')).toBeVisible();
  await expect.poll(() => result.locator('#preview-video').evaluate(video => [video.videoWidth, video.videoHeight])).toEqual([1920, 1080]);
  const saving = result.waitForEvent('download');
  await result.locator('#download-current-button').click();
  expect((await saving).suggestedFilename()).toMatch(/\.webm$/);
  await expect(playerTime).toHaveCount(0);
  await expect(popupTime).toBeEmpty();
});

test('MP4 recording, splitting, speed, GIF and frame exports work', async ({ extension }) => {
  test.setTimeout(90_000);
  const { context, worker, page } = extension;
  await prepareVideo(page);
  await worker.evaluate(() => chrome.storage.local.set({ settings: {
    enableShortcuts: true, enableFullRecordButton: true, outputFormat: 'mp4',
  } }));
  await page.keyboard.press('e');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState?.status)).toBe('recording');
  await page.waitForTimeout(8000); // Leave enough media after startup trimming and keyframe alignment.
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState >= 2 && video.duration > 3)).toBe(true);
  const sourceDuration = await result.locator('#preview-video').evaluate(video => video.duration);
  await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
  const retainedUrls = await result.evaluate(() => window.testObjectUrls.size);
  await interceptDownloads(result);
  for (const format of ['mp4', 'webm']) {
    await result.locator('#split-format-select').selectOption(format);
    await result.locator('[data-split-count="2"]').click();
    await result.locator('#split-button').click();
    await expect(result.locator('#split-result-summary')).toHaveText('나눈 파일 (2개)', { timeout: 30_000 });
    await expect(result.locator('#split-button')).toBeEnabled();
    for (const button of await result.locator('#split-files-list button').all()) await button.click();
    expect(await result.evaluate(async () => {
      const audio = new AudioContext();
      try {
        return await Promise.all(window.testDownloads.map(async download => {
          const decoded = await audio.decodeAudioData(await (await download).arrayBuffer());
          return decoded.numberOfChannels === 2 && [0, 1].every(channel =>
            decoded.getChannelData(channel).some(value => Math.abs(value) > 0.01));
        }));
      } finally { await audio.close(); }
    })).toEqual([true, true]);
    expect(await decodeDownloads(result)).toEqual([true, true]);
    await expectResultResourcesReleased(result, retainedUrls);
  }
  await result.locator('#speed-select').selectOption('2');
  await result.locator('#speed-convert-button').click();
  await expect.poll(() => result.evaluate(() => window.testDownloads.length), { timeout: 30_000 }).toBe(1);
  await expect(result.locator('#speed-convert-button')).toBeEnabled();
  expect(await decodeDownloads(result, sourceDuration / 2 + 0.5)).toEqual([true]);
  await expectResultResourcesReleased(result, retainedUrls);
  await result.locator('#capture-frame-button').click();
  await expect(result.locator('#frame-preview-image')).toBeVisible();
  for (const [selector, header] of [
    ['#frame-preview-download-button', [137, 80, 78, 71]],
    ['[data-convert-format="gif"]', [71, 73, 70, 56]],
  ]) {
    await result.locator(selector).click();
    await expect.poll(() => result.evaluate(() => window.testDownloads.length), { timeout: 30_000 }).toBe(1);
    const bytes = await result.evaluate(async () => {
      const [blob] = await Promise.all(window.testDownloads.splice(0));
      return Array.from(new Uint8Array(await blob.slice(0, 4).arrayBuffer()));
    });
    expect(bytes).toEqual(header);
  }
  await result.locator('#frame-preview-close-button').click();
  await expectResultResourcesReleased(result, retainedUrls);

  // Keep real engines; replace one EXEC command with an invalid codec.
  await result.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'EXEC') {
        Worker.prototype.postMessage = post;
        message = { ...message, data: { ...message.data,
          args: ['-i', '/source/input.mp4', '-c:v', 'cropclip-test-invalid-codec', 'output.mp4'],
        } };
      }
      return post.call(this, message, ...args);
    };
  });
  await result.locator('#trim-start-input').fill('0.2');
  await result.locator('#trim-start-input').press('Tab');
  const engineStarted = result.waitForEvent('worker');
  await result.locator('#download-current-button').click();
  await engineStarted;
  await expect(result.locator('#split-status')).toContainText('실시간');
  await expect.poll(async () => ({ workers: result.workers().length,
    stillConverting: await result.locator('#download-current-button').isDisabled(),
  })).toEqual({ workers: 0, stillConverting: true });
  await expect.poll(() => result.evaluate(() => window.testDownloads.length), { timeout: 30_000 }).toBe(1);
  await expect(result.locator('#download-current-button')).toBeEnabled();
  expect(await decodeDownloads(result)).toEqual([true]);
  await expectResultResourcesReleased(result, retainedUrls);
});

test('the browser action popup opens at full height', async () => {
  const directory = path.resolve(process.env.CROPCLIP_TEST_EXTENSION_DIR || 'dist');
  const context = await chromium.launchPersistentContext('', {
    channel: process.env.CROPCLIP_TEST_BROWSER || 'chromium',
    headless: true,
    viewport: null,
    args: [`--load-extension=${directory}`, `--disable-extensions-except=${directory}`, '--window-size=1280,900'],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const host = context.pages()[0] ?? await context.newPage();
    const cdp = await context.newCDPSession(host);
    await worker.evaluate(() => chrome.action.openPopup());
    const popupUrl = new URL('../popup/popup.html', worker.url()).href;
    const findPopup = async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url === popupUrl);
    await expect.poll(findPopup).toBeDefined();
    const { targetId } = await findPopup();
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId });
    let requestId = 0;
    const readSize = () => new Promise((resolve, reject) => {
      const id = ++requestId;
      const finish = () => {
        clearTimeout(timeout);
        cdp.off('Target.receivedMessageFromTarget', onMessage);
      };
      const onMessage = ({ sessionId: sender, message }) => {
        if (sender !== sessionId) return;
        const response = JSON.parse(message);
        if (response.id !== id) return;
        finish();
        resolve(response.result?.result?.value);
      };
      const timeout = setTimeout(() => {
        finish();
        reject(new Error('The browser action popup did not report its dimensions.'));
      }, 5_000);
      cdp.on('Target.receivedMessageFromTarget', onMessage);
      void cdp.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => {
              const root = document.documentElement.getBoundingClientRect();
              const body = document.body?.getBoundingClientRect();
              const panel = document.querySelector('.panel')?.getBoundingClientRect();
              return {
                requestedWidth: root.width,
                requestedHeight: root.height,
                bodyFits: body?.width === Math.min(640, innerWidth) && body?.height === Math.min(560, innerHeight),
                settingsVisible: !!panel && panel.height > 350 && panel.right <= innerWidth && panel.bottom <= innerHeight,
              };
            })()`,
            returnByValue: true,
          },
        }),
      }).catch(error => {
        finish();
        reject(error);
      });
    });
    await expect.poll(readSize).toEqual({ requestedWidth: 640, requestedHeight: 560, bodyFits: true, settingsVisible: true });
  } finally {
    await context.close();
  }
});

test('shortcut tab supports navigation, changing keys and cancelling key entry', async ({ extension }) => {
  const { context, worker } = extension;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await expect(popup.locator('input[name="shortcut-mode"][value="on"]')).toBeChecked();
  const shortcutTab = popup.getByRole('tab', { name: '단축키', exact: true });
  await shortcutTab.click();
  const panel = popup.getByRole('tabpanel', { name: '단축키' });
  const key = panel.locator('[data-action="regionRecord"]');
  const columns = await panel.locator('#shortcut-list').evaluate(list => getComputedStyle(list).gridTemplateColumns.split(' '));
  expect(columns).toHaveLength(2);
  expect(await panel.evaluate(tab => tab.scrollHeight - tab.clientHeight)).toBe(0);
  await key.focus();
  await popup.keyboard.press('Tab');
  await expect(panel.locator('[data-action="cancelRecording"]')).toBeFocused();
  await key.focus();
  await popup.keyboard.press('Enter');
  await expect(key).toHaveText('입력');
  await popup.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: '취소', exact: true })).toBeFocused();
  await popup.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  await expect(key).toBeFocused();
  await expect(key).toHaveText('R');
  await key.press('Enter');
  await key.press('q');
  await expect(key).toHaveText('Q');
  await expect(key).toBeFocused();
  await key.press('Enter');
  await popup.getByRole('tab', { name: '녹화', exact: true }).click();
  await shortcutTab.click();
  await expect(key).toHaveText('Q');
  const reset = panel.getByRole('button', { name: '단축키 초기화' });
  const resetBox = await reset.boundingBox();
  const toggleBox = await panel.getByRole('radiogroup', { name: '단축키 사용' }).boundingBox();
  expect(resetBox.x + resetBox.width).toBeLessThan(toggleBox.x);
  expect(Math.abs(resetBox.y + resetBox.height / 2 - toggleBox.y - toggleBox.height / 2)).toBeLessThan(1);
  const background = await reset.evaluate(button => getComputedStyle(button).backgroundColor);
  await reset.hover();
  await expect.poll(() => reset.evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe(background);
  expect((await reset.boundingBox()).y).toBe(resetBox.y);
  const confirmReset = popup.getByRole('dialog', { name: '단축키 초기화' });
  await reset.click();
  await expect(confirmReset).toBeVisible();
  await expect(confirmReset.getByRole('button', { name: '취소' })).toBeFocused();
  await confirmReset.getByRole('button', { name: '취소' }).click();
  await expect(confirmReset).toBeHidden();
  await expect(key).toHaveText('Q');
  await reset.click();
  await confirmReset.getByRole('button', { name: '초기화', exact: true }).click();
  await expect(key).toHaveText('R');
  await key.press('Enter');
  await worker.evaluate(() => chrome.storage.local.set({ recordingState: { status: 'recording', mode: 'full' } }));
  await expect(key).toBeDisabled();
  await expect(key).toHaveText('R');
  await expect(panel.getByRole('button', { name: '단축키 초기화' })).toBeDisabled();
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
  await worker.evaluate(() => chrome.storage.local.set({ region: { x: 100, y: 100, width: 400, height: 200 } }));
  await expect(page.locator('.crop-clip-border')).toBeVisible();
  await page.reload(); // Initial state and storage updates use the same normalization.
  await expect(page.locator('#crop-clip-chzzk-record-button')).toBeVisible();
  await expect.poll(() => worker.evaluate(() => chrome.storage.local.get(['region', 'regions'])))
    .toEqual({ region: null, regions: [] });
  await expect(popup.locator('#custom-video-bitrate-input')).toHaveValue('8');
});

test('settings updates preserve an unfinished bitrate edit and other preferences', async ({ extension }) => {
  const { context, worker, page } = extension;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  const bitrate = popup.locator('#custom-video-bitrate-input');
  await expect(bitrate).toHaveValue('8');
  await bitrate.fill('0.');
  const screenshotToggle = popup.locator('input[name="full-screenshot-mode"][value="on"]');
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enableFullScreenshotButton: true } });
  });
  await expect(page.locator('#crop-clip-chzzk-screenshot-button')).toBeVisible();
  await expect(screenshotToggle).toBeChecked();
  await expect(bitrate).toHaveValue('0.');
  await popup.getByRole('tab', { name: '플레이어' }).click();
  await popup.locator('label:has(input[name="seek-button-mode"][value="on"])').click();
  await expect.poll(() => worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    return { seek: settings.enableSeek, screenshot: settings.enableFullScreenshotButton, bitrate: settings.videoBitsPerSecond };
  })).toEqual({ seek: true, screenshot: true, bitrate: 8_000_000 });

  const secondPopup = await context.newPage();
  await secondPopup.goto(popup.url());
  const replies = await Promise.all([
    popup.evaluate(() => chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: { enable60fps: true, videoBitsPerSecond: 9_500_000 } })),
    secondPopup.evaluate(() => chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: { autoSplitAfterSeconds: 52 } })),
  ]);
  expect(replies).toEqual([{ ok: true }, { ok: true }]);
  await expect(popup.locator('input[name="fps-mode"][value="on"]')).toBeChecked();
  await expect(secondPopup.locator('#auto-split-threshold')).toHaveValue('52');
  await expect(secondPopup.locator('#custom-video-bitrate-input')).toHaveValue('9.5');
  await expect(secondPopup.locator('input[name="full-screenshot-mode"][value="on"]')).toBeChecked();

  const reset = secondPopup.getByRole('button', { name: '전체 초기화' });
  await reset.click();
  const confirmReset = secondPopup.getByRole('dialog', { name: '전체 설정 초기화' });
  await confirmReset.getByRole('button', { name: '취소' }).click();
  await expect(secondPopup.locator('#auto-split-threshold')).toHaveValue('52');
  await reset.click();
  await confirmReset.getByRole('button', { name: '초기화', exact: true }).click();
  await expect(secondPopup.locator('#auto-split-threshold')).toHaveValue('35');
  await expect(secondPopup.locator('#custom-video-bitrate-input')).toHaveValue('8');
  await expect(popup.locator('input[name="fps-mode"][value="off"]')).toBeChecked();
  await expect(page.locator('#crop-clip-chzzk-screenshot-button')).toHaveCount(0);
});

test('rapid bitrate increases keep the latest value while storage catches up', async ({ extension }) => {
  const { context, worker } = extension;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  const bitrate = popup.locator('#custom-video-bitrate-input');
  const increase = popup.getByRole('button', { name: '비트레이트 증가' });
  await expect(bitrate).toHaveValue('8');
  await worker.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      if (items.settings?.videoBitsPerSecond === 9_000_000) {
        chrome.storage.local.set = set;
        await new Promise(resolve => { globalThis.releaseBitrateStep = resolve; });
      }
      return set(items);
    };
  });
  await increase.evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => worker.evaluate(() => Boolean(globalThis.releaseBitrateStep))).toBe(true);
  try {
    await expect(bitrate).toHaveValue('9');
    await increase.click();
    await expect(bitrate).toHaveValue('9.5');
  } finally {
    await worker.evaluate(() => globalThis.releaseBitrateStep());
  }
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.videoBitsPerSecond)).toBe(9_500_000);
  await popup.reload();
  await expect(bitrate).toHaveValue('9.5');
});

test('failed bitrate saves restore the value shown in the focused input', async ({ extension }) => {
  const { context, worker } = extension;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await worker.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = items => {
      if (items.settings?.videoBitsPerSecond === 16_000_000) return Promise.reject(new Error('Injected bitrate write failure'));
      return set(items);
    };
  });
  const bitrate = popup.locator('#custom-video-bitrate-input');
  await expect(bitrate).toHaveValue('8');
  await bitrate.fill('16');
  await expect(popup.locator('#popup-error')).toContainText('Injected bitrate write failure');
  await expect(bitrate).toBeFocused();
  await expect(bitrate).toHaveValue('8');
});

test('rapid automatic split threshold steps keep the latest value', async ({ extension }) => {
  const { context, worker } = extension;
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enableAutoSplitRecording: true } });
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      if (items.settings?.autoSplitAfterSeconds === 37) {
        chrome.storage.local.set = set;
        await new Promise(resolve => { globalThis.releaseThresholdWrite = resolve; });
      }
      return set(items);
    };
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await popup.getByRole('tab', { name: '저장·분할' }).click();
  const threshold = popup.locator('#auto-split-threshold');
  const increase = popup.locator('#auto-split-threshold-increase');
  await expect(threshold).toHaveValue('35');
  await increase.evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => worker.evaluate(() => Boolean(globalThis.releaseThresholdWrite))).toBe(true);
  try {
    await expect(threshold).toHaveValue('37');
    await increase.click();
    await expect(threshold).toHaveValue('38');
  } finally {
    await worker.evaluate(() => globalThis.releaseThresholdWrite());
  }
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.autoSplitAfterSeconds)).toBe(38);
});

test('popup settings work with an older background that cannot update settings', async ({ extension }) => {
  const { context, worker } = extension;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await popup.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => message?.type === 'UPDATE_SETTINGS'
      ? Promise.resolve({ ok: false, error: '지원하지 않는 메시지입니다.' }) : send(message, ...args);
  });
  await popup.getByRole('tab', { name: '저장·분할' }).click();
  await popup.locator('label:has(input[name="auto-split"][value="on"])').click();
  const size = popup.locator('label:has(input[name="auto-split-kind"][value="size"])');
  await expect(size.locator('input')).toBeEnabled();
  await size.click();
  await expect(popup.getByRole('spinbutton', { name: '파일당 최대 용량' })).toBeVisible();
  await popup.getByRole('button', { name: '파일당 최대 용량 늘리기' }).click();
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings))
    .toMatchObject({ enableAutoSplitRecording: true, autoSplitMode: 'size', autoSplitMaxMegabytes: 41, enableShortcuts: true });
  await expect(popup.locator('#popup-error')).toBeEmpty();
});

test('popup settings persist and only the recording size toggle stays editable during capture', async ({ extension }) => {
  const { context, worker } = extension;
  let popup = await context.newPage();
  const url = `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`;
  await popup.goto(url);
  const readSettings = () => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  await expect(popup.locator('input[name="shortcut-mode"][value="on"]')).toBeChecked();

  const regionCount = popup.locator('#multi-region-count-input');
  await expect(regionCount).toBeVisible();
  await expect(regionCount).toBeDisabled();
  await popup.locator('label:has(input[name="multi-region-mode"][value="on"])').click();
  await expect(popup.locator('#multi-region-count-row')).toBeVisible();
  await expect(popup.locator('#recording-settings > :last-child')).toHaveAttribute('id', 'multi-region-count-row');
  await popup.locator('#multi-region-count-increase-button').click();
  await expect.poll(async () => (await readSettings()).multiRegionMaxCount).toBe(3);
  const choose = (name, value) => popup.locator(`label:has(input[name="${name}"][value="${value}"])`).click();
  await choose('output-format', 'mp4');
  for (const name of ['original-stream-mode', 'fps-mode', 'muted-recording-mode', 'streamer-filename-mode']) await choose(name, 'on');
  const bitrate = popup.locator('#custom-video-bitrate-input');
  await bitrate.fill('8.5');
  await bitrate.press('Tab');
  const recordingTab = popup.getByRole('tab', { name: '녹화', exact: true });
  const playerTab = popup.getByRole('tab', { name: '플레이어' });
  const savingTab = popup.getByRole('tab', { name: '저장·분할' });
  await recordingTab.press('ArrowDown');
  await expect(playerTab).toBeFocused();
  await expect(playerTab).toHaveAttribute('aria-selected', 'true');
  await choose('full-record-mode', 'off');
  await choose('full-screenshot-mode', 'on');
  const seekSeconds = popup.locator('#seek-seconds-input');
  await expect(seekSeconds).toBeVisible();
  await expect(seekSeconds).toBeDisabled();
  await popup.locator('label:has(input[name="seek-button-mode"][value="on"])').click();
  await seekSeconds.fill('999');
  await seekSeconds.press('Tab');
  await expect(seekSeconds).toHaveValue('60');
  await popup.locator('#seek-decrease-button').click();
  await expect.poll(async () => (await readSettings()).seekSeconds).toBe(59);
  await savingTab.click();
  const splitMode = popup.locator('#auto-split-mode-row');
  const timeSplit = popup.getByRole('combobox', { name: '시간 나누기' });
  const splitLayout = () => splitMode.evaluate(group => {
    const panel = group.closest('.settings-group');
    return {
      popupHeight: document.body.clientHeight, panelHeight: panel.clientHeight,
      horizontalOverflow: panel.scrollWidth - panel.clientWidth,
    };
  });
  await expect(splitMode).toBeVisible();
  await expect(timeSplit).toBeDisabled();
  const initialSplitLayout = await splitLayout();
  await choose('auto-download-recording-mode', 'on');
  await expect.poll(async () => (await readSettings()).enableAutoDownloadRecording).toBe(true);
  await popup.locator('label:has(input[name="auto-split"][value="on"])').click();
  const splitFormat = popup.getByRole('radiogroup', { name: '분할 저장 형식' });
  await expect(timeSplit).toHaveValue('half');
  await expect(timeSplit).toBeEnabled();
  await expect(splitMode.locator('input[name="auto-split-kind"][value="duration"]')).toBeChecked();
  await expect(timeSplit.getByRole('option')).toHaveText(['절반', '3분할', '4분할', '직접 입력']);
  await expect(popup.locator('#auto-split-interval-row')).toBeHidden();
  await expect(splitFormat.getByRole('radio', { name: 'MP4' })).toBeChecked();
  expect(await splitLayout()).toEqual(initialSplitLayout);
  const formatPosition = () => splitFormat.evaluate(select => {
    const bounds = select.getBoundingClientRect();
    return { x: bounds.x, width: bounds.width, height: bounds.height, offset: select.offsetTop };
  });
  const initialFormatPosition = await formatPosition();
  const timeBounds = await popup.locator('.split-time-picker').boundingBox();
  expect(timeBounds).toMatchObject({ x: initialFormatPosition.x, width: initialFormatPosition.width });
  expect((await splitFormat.boundingBox()).y).toBeLessThan(timeBounds.y);
  await expect(timeSplit).toHaveCSS('text-align-last', 'center');
  await expect(timeSplit).toHaveCSS('appearance', 'none');
  const previousTimeMode = popup.getByRole('button', { name: '이전 시간 나누기 방식' });
  const nextTimeMode = popup.getByRole('button', { name: '다음 시간 나누기 방식' });
  await previousTimeMode.click();
  await expect(timeSplit).toHaveValue('duration');
  await expect.poll(async () => (await readSettings()).autoSplitMode).toBe('duration');
  await nextTimeMode.click();
  await expect(timeSplit).toHaveValue('half');
  await expect.poll(async () => (await readSettings()).autoSplitMode).toBe('half');
  const threshold = popup.getByRole('spinbutton', { name: '이 시간 초과 시 분할' });
  const increaseThreshold = popup.getByRole('button', { name: '자동 분할 기준 시간 늘리기' });
  const decreaseThreshold = popup.getByRole('button', { name: '자동 분할 기준 시간 줄이기' });
  await expect(threshold).toHaveValue('35');
  await increaseThreshold.click();
  await expect.poll(async () => (await readSettings()).autoSplitAfterSeconds).toBe(36);
  await decreaseThreshold.click();
  await expect.poll(async () => (await readSettings()).autoSplitAfterSeconds).toBe(35);
  await threshold.fill('75');
  await threshold.press('Enter');
  await expect.poll(async () => (await readSettings()).autoSplitAfterSeconds).toBe(75);
  await timeSplit.selectOption('quarters');
  await expect.poll(async () => (await readSettings()).autoSplitMode).toBe('quarters');
  await timeSplit.selectOption('duration');
  await expect.poll(async () => (await readSettings()).autoSplitMode).toBe('duration');
  await worker.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      if (items.settings?.autoSplitMode !== 'size') return set(items);
      chrome.storage.local.set = set;
      await new Promise(resolve => { globalThis.finishSizeSetting = resolve; });
      return set(items);
    };
  });
  await choose('auto-split-kind', 'size');
  await expect(popup.locator('#auto-split-max-megabytes')).toBeVisible();
  await expect(threshold).toBeHidden();
  await expect(timeSplit).toBeHidden();
  expect(await formatPosition()).toEqual(initialFormatPosition);
  await expect.poll(() => worker.evaluate(() => Boolean(globalThis.finishSizeSetting))).toBe(true);
  await choose('auto-split-kind', 'duration');
  await expect(popup.locator('#auto-split-interval')).toBeVisible();
  await expect(threshold).toHaveValue('75');
  await worker.evaluate(() => globalThis.finishSizeSetting());
  await expect.poll(async () => (await readSettings()).autoSplitMode).toBe('duration');
  await expect(timeSplit).toHaveValue('duration');
  expect(await splitLayout()).toEqual(initialSplitLayout);

  await choose('auto-split-kind', 'size');
  const maxMegabytes = popup.getByRole('spinbutton', { name: '파일당 최대 용량' });
  await expect(maxMegabytes).toHaveValue('40');
  await expect(threshold).toBeHidden();
  expect(await splitLayout()).toEqual(initialSplitLayout);
  await popup.getByRole('button', { name: '파일당 최대 용량 줄이기' }).click();
  await expect.poll(async () => (await readSettings()).autoSplitMaxMegabytes).toBe(39);
  await choose('auto-split-format', 'webm');
  await expect.poll(async () => (await readSettings()).autoSplitFormat).toBe('webm');
  await choose('auto-split-kind', 'duration');
  await expect(maxMegabytes).toBeHidden();
  const interval = popup.getByRole('spinbutton', { name: '파일당 시간' });
  const increaseInterval = popup.getByRole('button', { name: '파일당 시간 늘리기' });
  await expect(interval).toHaveValue('30');
  expect(await splitLayout()).toEqual(initialSplitLayout);
  await interval.fill('44');
  await interval.press('Tab');
  await expect.poll(async () => (await readSettings()).autoSplitIntervalSeconds).toBe(44);
  await increaseInterval.click();
  await choose('auto-split', 'off');
  await expect(interval).toBeDisabled();
  await expect(interval).toBeVisible();
  expect(await splitLayout()).toEqual(initialSplitLayout);
  await choose('auto-split', 'on');
  await expect(interval).toBeEnabled();
  await choose('auto-focus-result-mode', 'off');
  await choose('auto-download-split-mode', 'on');
  await expect.poll(readSettings).toMatchObject({
    outputFormat: 'mp4', videoBitsPerSecond: 8_500_000, enable60fps: true,
    allowMutedRecording: true, enableOriginalStreamRecording: true, enableStreamerFilename: true,
    enableFullRecordButton: false, enableFullScreenshotButton: true, autoFocusResult: false,
    enableAutoDownloadRecording: true, enableAutoDownloadSplit: true,
    autoSplitMode: 'duration', autoSplitAfterSeconds: 75, autoSplitIntervalSeconds: 45, autoSplitFormat: 'webm', autoSplitMaxMegabytes: 39,
  });
  await popup.setViewportSize({ width: 640, height: 600 });
  const frameGeometry = () => popup.evaluate(() => {
    const sidebar = document.querySelector('.settings-tabs').getBoundingClientRect();
    const footer = document.querySelector('.footer-links').getBoundingClientRect();
    const body = document.body;
    return { height: body.clientHeight, sidebarBottom: sidebar.bottom, footerBottom: footer.bottom, bodyScroll: body.scrollTop };
  });
  const savingLayout = await frameGeometry();
  expect(savingLayout.height).toBe(560);
  expect(savingLayout.sidebarBottom).toBe(savingLayout.footerBottom);
  await playerTab.click();
  expect(await frameGeometry()).toEqual(savingLayout);
  await savingTab.click();
  await popup.setViewportSize({ width: 640, height: 320 });
  const smallLayout = await frameGeometry();
  expect(smallLayout.height).toBe(320);
  const savingPanel = popup.getByRole('tabpanel', { name: '저장·분할' });
  await savingPanel.hover();
  await popup.mouse.wheel(0, 600);
  await expect.poll(() => savingPanel.evaluate(panel => panel.scrollTop)).toBeGreaterThan(0);
  expect(await frameGeometry()).toEqual(smallLayout);
  await popup.setViewportSize({ width: 640, height: 600 });

  await worker.evaluate(() => chrome.storage.local.set({ recordingState: { status: 'recording', mode: 'full' } }));
  await expect(popup.locator('input[name="output-format"][value="webm"]')).toBeDisabled();
  await expect(popup.locator('input[name="seek-button-mode"][value="off"]')).toBeDisabled();
  await expect(popup.locator('#multi-region-count-increase-button')).toBeDisabled();
  await expect(increaseThreshold).toBeDisabled();
  await expect(increaseInterval).toBeDisabled();
  await expect(timeSplit).toBeDisabled();
  await expect(previousTimeMode).toBeDisabled();
  await expect(nextTimeMode).toBeDisabled();
  await expect(splitFormat.getByRole('radio', { name: 'WebM' })).toBeDisabled();
  expect(await popup.locator('input[type="radio"]:not([name="recording-size-mode"]):enabled').count()).toBe(0);
  await playerTab.click();
  await popup.locator('label:has(input[name="recording-size-mode"][value="on"])').click();
  await expect.poll(async () => (await readSettings()).showRecordingSize).toBe(true);
  await worker.evaluate(() => chrome.storage.local.set({ recordingState: { status: 'idle' } }));
  await expect(seekSeconds).toBeEnabled();

  await popup.close();
  popup = await context.newPage();
  await popup.goto(url);
  await expect(popup.locator('#seek-seconds-input')).toHaveValue('59');
  await expect(popup.locator('#multi-region-count-input')).toHaveValue('3');
  await expect(popup.locator('input[name="recording-size-mode"][value="on"]')).toBeChecked();
  await expect(popup.locator('input[name="auto-focus-result-mode"][value="off"]')).toBeChecked();
  await expect(popup.locator('#auto-split-threshold')).toHaveValue('75');
  await expect(popup.locator('#auto-split-interval')).toHaveValue('45');
  await popup.getByRole('tab', { name: '저장·분할' }).click();
  await expect(popup.getByRole('combobox', { name: '시간 나누기' })).toHaveValue('duration');
  await expect(popup.getByRole('radiogroup', { name: '분할 저장 형식' }).getByRole('radio', { name: 'WebM' })).toBeChecked();
  await expect(popup.locator('#auto-split-max-megabytes')).toHaveValue('39');
});

test('result delivery reuses its tab after a failed state write', async ({ extension }) => {
  const { context, worker } = extension;
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ recordingState: { status: 'completed', recordingId: 'delivery-test' } });
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = items => {
      if (items.recordingState?.status === 'idle') {
        chrome.storage.local.set = set;
        return Promise.reject(new Error('Injected state write failure'));
      }
      return set(items);
    };
  });
  const opened = context.waitForEvent('page');
  await worker.evaluate(() => chrome.alarms.create('open-recording-result', { when: Date.now() }));
  const result = await opened;
  await expect(result).toHaveURL(/result\/result.html\?id=delivery-test/);
  await expect.poll(() => worker.evaluate(async () => (await chrome.alarms.get('open-recording-result'))?.scheduledTime ?? 0)).toBeGreaterThan(Date.now() + 1000);
  await worker.evaluate(() => chrome.alarms.create('open-recording-result', { when: Date.now() }));
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
  expect(context.pages().filter(page => page.url().includes('result/result.html?id=delivery-test'))).toHaveLength(1);
});

test('automatic download with missing data shows the error and unlocks recording', async ({ extension }) => {
  const { context, worker } = extension;
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || location.pathname !== '/result/result.html') return;
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 500 ? 0 : ms, ...args);
  });
  const opened = context.waitForEvent('page');
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      settings: { enableAutoDownloadRecording: true, autoFocusResult: false },
      recordingState: { status: 'completed', recordingId: 'missing-download' },
    });
    await chrome.alarms.create('open-recording-result', { when: Date.now() });
  });
  const result = await opened;
  await expect(result.locator('#empty-message')).toHaveText('녹화 데이터를 찾지 못했습니다.');
  expect(new URL(result.url()).searchParams.get('id')).toBe('missing-download');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
  await expect.poll(() => result.evaluate(async () => (await chrome.tabs.getCurrent())?.active)).toBe(true);
  await expect(result.locator('#split-button')).toBeDisabled();
});

test('failed automatic download keeps the recorded video available in the result tab', async ({ extension }) => {
  const { context, worker, page } = extension;
  await prepareVideo(page);
  const bytes = await page.locator('video').evaluate(async video => Array.from(new Uint8Array(await (await fetch(video.src)).arrayBuffer())));
  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await seed.evaluate(async bytes => {
    const { putPart, putRecording } = await import('/shared/idb.js');
    const id = 'failed-download';
    const blob = new Blob([Uint8Array.from(bytes)], { type: 'video/webm' });
    const createdAt = Date.now();
    await putPart({ id: `${id}:part:001`, recordingId: id, index: 1, filename: 'clip.webm', mimeType: blob.type,
      extension: 'webm', size: blob.size, blob, createdAt });
    await putRecording({ id, createdAt, endedAt: createdAt + 3000, totalSize: blob.size, actualExtension: 'webm' });
    await chrome.storage.local.set({
      settings: { enableAutoDownloadRecording: true, autoFocusResult: false },
      recordingState: { status: 'completed', recordingId: id },
    });
  }, bytes);
  await seed.close();
  await context.addInitScript(() => {
    if (location.protocol === 'chrome-extension:' && location.pathname === '/result/result.html') {
      const WorkerConstructor = window.Worker;
      window.Worker = class extends WorkerConstructor {
        constructor(...args) {
          super(...args);
          window.testConversionWorkers = (window.testConversionWorkers ?? 0) + 1;
        }
      };
      chrome.downloads.download = async () => { throw new Error('테스트 다운로드 실패'); };
    }
  });
  const opened = context.waitForEvent('page');
  await worker.evaluate(() => chrome.alarms.create('open-recording-result', { when: Date.now() }));
  const result = await opened;
  await expect(result.locator('#split-status')).toHaveText('테스트 다운로드 실패');
  await expect(result.locator('#preview-recovery')).toBeHidden();
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
  await expect(result.locator('#download-current-button')).toBeEnabled();
  await expect.poll(() => result.evaluate(async () => (await chrome.tabs.getCurrent())?.active)).toBe(true);
  expect(await result.evaluate(() => window.testConversionWorkers ?? 0)).toBe(0);
});

test('automatic download respects the result tab preference and does not repeat on reload', async ({ extension }, testInfo) => {
  test.setTimeout(120_000);
  const { context, worker, page } = extension;
  await prepareVideo(page);
  const downloadPath = testInfo.outputPath('automatic');
  await mkdir(downloadPath, { recursive: true });
  const session = await context.newCDPSession(page);
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  const readState = () => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState);
  const downloads = () => worker.evaluate(() => chrome.downloads.search({ state: 'complete' }));
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || location.pathname !== '/result/result.html'
      || new URLSearchParams(location.search).get('testLegacyResult') !== '1') return;
    const save = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = async options => {
      await new Promise(resolve => { window.releaseAutomaticDownload = resolve; });
      return save(options);
    };
  });

  const scenarios = [
    { autoFocusResult: false, enableDuringDownload: false },
    { autoFocusResult: true, enableDuringDownload: false },
    { autoFocusResult: false, enableDuringDownload: true },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const keepOpen = scenario.autoFocusResult || scenario.enableDuringDownload;
    await worker.evaluate(async ({ autoFocusResult, enableDuringDownload }) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, enableAutoDownloadRecording: true, autoFocusResult } });
      if (autoFocusResult || enableDuringDownload) {
        const create = chrome.tabs.create.bind(chrome.tabs);
        chrome.tabs.create = options => {
          if (!options.url?.includes('/result/result.html')) return create(options);
          chrome.tabs.create = create;
          const url = new URL(options.url);
          url.searchParams.delete('keepOpen');
          url.searchParams.set('testLegacyResult', '1');
          return create({ ...options, url: url.href });
        };
      }
    }, scenario);
    await page.bringToFront();
    await page.keyboard.press('e');
    await expect.poll(async () => (await readState())?.startedAt ?? 0).toBeGreaterThan(0);
    await page.waitForTimeout(3_100);
    const opened = context.waitForEvent('page');
    await page.keyboard.press('e');
    const result = await opened;
    if (keepOpen) {
      expect(new URL(result.url()).searchParams.has('keepOpen')).toBe(false);
      await expect.poll(() => result.evaluate(() => Boolean(window.releaseAutomaticDownload))).toBe(true);
      if (scenario.autoFocusResult) await expect(result.locator('#preview-video')).toBeVisible();
      await expect(result.locator('#result-loading-message')).toHaveText('녹화 파일을 다운로드하는 중입니다.');
      await expect(result.locator('#split-button')).toBeDisabled();
      expect(await downloads()).toHaveLength(index);
      if (scenario.enableDuringDownload) {
        await worker.evaluate(async () => {
          const { settings } = await chrome.storage.local.get('settings');
          await chrome.storage.local.set({ settings: { ...settings, autoFocusResult: true } });
        });
      }
      await result.evaluate(() => window.releaseAutomaticDownload());
    }
    await expect.poll(async () => (await readState()).status, { timeout: 35_000 }).toBe('idle');
    const expectedCount = index + 1;
    expect(await downloads()).toHaveLength(expectedCount);
    if (!keepOpen) {
      await expect.poll(() => result.isClosed()).toBe(true);
      continue;
    }

    await expect(result.locator('#result-loading')).toBeHidden();
    await expect(result.locator('#split-button')).toBeEnabled();
    await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0)).toBe(true);
    expect(new URL(result.url()).searchParams.has('autoDownload')).toBe(false);
    expect(await result.evaluate(async () => (await chrome.tabs.getCurrent())?.active)).toBe(true);

    await result.reload();
    await expect(result.locator('#split-button')).toBeEnabled();
    expect(await downloads()).toHaveLength(expectedCount);
    await result.close();
  }
});

for (const stallMetadata of [false, true]) test(
  `a download requested during preparation uses the same file as the result${stallMetadata ? ' if preview metadata is delayed' : ''}`,
  async ({ extension }) => {
  const { context, worker, page } = extension;
  await prepareVideo(page, stallMetadata ? 320 : 640, stallMetadata ? 568 : 360);
  await context.addInitScript(stallMetadata => {
    if (location.protocol !== 'chrome-extension:' || location.pathname !== '/result/result.html') return;
    if (stallMetadata) {
      addEventListener('loadedmetadata', event => {
        if (event.target.id === 'preview-video') event.stopImmediatePropagation();
      }, true);
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 15_000 ? 500 : ms, ...args);
    }
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'EXEC' && !window.releaseEditPreparation) {
        window.releaseEditPreparation = () => send.call(this, message, ...args);
        return;
      }
      return send.call(this, message, ...args);
    };
  }, stallMetadata);
  await page.keyboard.press('e');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState?.startedAt ?? 0)).toBeGreaterThan(0);
  await page.waitForTimeout(3500);
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect.poll(() => result.evaluate(() => Boolean(window.releaseEditPreparation))).toBe(true);
  await expect(result.locator('#title')).toHaveText('녹화 결과');
  const preview = result.locator('.preview-frame');
  const loading = preview.locator('#result-loading');
  await expect(preview.getByRole('status')).toHaveText('미리보기를 준비하는 중입니다.');
  await expect(result.locator('#preview-video')).toBeHidden();
  expect(await result.locator('#title').evaluate(title => {
    const bounds = title.getBoundingClientRect();
    return title.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })).toBe(true);
  await expect(result.locator('#split-button')).toBeDisabled();
  const download = result.locator('#download-current-button');
  await expect(download).toBeEnabled();
  if (stallMetadata) await result.setViewportSize({ width: 380, height: 780 });
  const previewBounds = await preview.boundingBox();
  const loadingBounds = await loading.boundingBox();
  const editorTop = (await result.locator('.trim-editor').boundingBox()).y;
  expect(previewBounds.width / previewBounds.height).toBeCloseTo(16 / 9, 2);
  expect(previewBounds.height).toBeLessThanOrEqual(Math.min(result.viewportSize().height / 2, 460));
  expect(loadingBounds.height).toBeCloseTo(previewBounds.height - 2, 0);
  expect(loadingBounds.width).toBeCloseTo(previewBounds.width - 2, 0);
  const downloadBounds = await download.boundingBox();
  const closeBounds = await result.locator('#close-button').boundingBox();
  expect(downloadBounds.y + downloadBounds.height / 2).toBeCloseTo(closeBounds.y + closeBounds.height / 2, 0);
  expect(downloadBounds.x + downloadBounds.width).toBeLessThanOrEqual(closeBounds.x);
  expect(downloadBounds.height).toBeGreaterThanOrEqual(40);
  expect((await result.locator('#download-current-label').boundingBox()).width).toBeGreaterThan(40);
  if (stallMetadata) {
    const durationBounds = await result.locator('.trim-duration').boundingBox();
    expect(durationBounds.x + durationBounds.width).toBeLessThan(380);
  }
  await expect(result.locator('#result-loading button')).toHaveCount(0);
  await result.evaluate(() => {
    window.downloadedFiles = [];
    HTMLAnchorElement.prototype.click = function () {
      window.downloadedFiles.push(fetch(this.href).then(async response => ({
        filename: this.download,
        digest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))),
      })));
    };
  });
  await download.click();
  await expect(download).toHaveText('다운로드 예약됨');
  await expect(download).toBeDisabled();
  await expect(result.locator('#result-loading')).toBeVisible();
  expect(await result.evaluate(() => window.downloadedFiles.length)).toBe(0);
  await result.evaluate(() => window.releaseEditPreparation());
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30_000 });
  await expect(result.locator('#preview-waiting')).toBeHidden();
  await expect(result.locator('#preview-video')).toBeVisible();
  expect(await preview.boundingBox()).toEqual(previewBounds);
  expect((await result.locator('.trim-editor').boundingBox()).y).toBeCloseTo(editorTop, 0);
  const videoBounds = await result.locator('#preview-video').boundingBox();
  expect(videoBounds.x + videoBounds.width / 2).toBeCloseTo(previewBounds.x + previewBounds.width / 2, 0);
  if (stallMetadata) expect(videoBounds.width).toBeLessThan(previewBounds.width / 2);
  else expect(Math.abs(videoBounds.width - (previewBounds.width - 2))).toBeLessThan(2);
  await expect.poll(() => result.evaluate(() => window.downloadedFiles.length)).toBe(1);
  await download.click();
  const files = await result.evaluate(() => Promise.all(window.downloadedFiles));
  expect(files).toHaveLength(2);
  expect(files[0]).toEqual(files[1]);
});

test('full screen recording waits for a pending bitrate change and keeps native resolution', async ({ extension }) => {
  const { context, worker, page } = extension;
  await prepareVideo(page, 1280, 720);
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, videoBitsPerSecond: 2_000_000 } });
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const Recorder = MediaRecorder;
      window.MediaRecorder = class extends Recorder {
        constructor(stream, options) {
          super(stream, options);
          document.documentElement.dataset.screenVideoBitrate = `${options.videoBitsPerSecond}/${this.videoBitsPerSecond}`;
        }
      };
    } });
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async items => {
      if (items.settings?.videoBitsPerSecond === 8_500_000) {
        chrome.storage.local.set = set;
        await new Promise(resolve => { globalThis.releaseBitrateWrite = resolve; });
      }
      return set(items);
    };
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await popup.locator('#custom-video-bitrate-input').fill('8.5');
  await popup.locator('#custom-video-bitrate-input').press('Tab');
  await expect.poll(() => worker.evaluate(() => Boolean(globalThis.releaseBitrateWrite))).toBe(true);
  await page.bringToFront();
  await page.keyboard.press('e');
  const record = page.locator('#crop-clip-chzzk-record-button');
  try {
    await expect(record).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('html')).not.toHaveAttribute('data-screen-video-bitrate');
  } finally {
    await worker.evaluate(() => globalThis.releaseBitrateWrite());
  }
  await expect(page.locator('html')).toHaveAttribute('data-screen-video-bitrate', '8500000/8500000');
  await expect(record).toHaveAttribute('data-recording', '');
  await page.waitForTimeout(2600);
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => [video.videoWidth, video.videoHeight])).toEqual([1280, 720]);
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

test('real recordings survive mini-player moves, split and recover a failed checkpoint', async ({ extension }) => {
  test.setTimeout(180_000);
  const { context, worker, page } = extension;
  const dialogs = [];
  const collectDialogs = target => target.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  context.on('page', collectDialogs);
  collectDialogs(page);
  // Play a generated file like the site's media player. A srcObject capture shares
  // its input source in Chromium, so stopping its captured track also ends that source.
  // CropClip's recorder, checkpoint storage and FFmpeg are unmocked.
  await prepareVideo(page);
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
  await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
  const retainedUrls = await result.evaluate(() => window.testObjectUrls.size);
  await interceptDownloads(result);
  for (const trimmed of [false, true]) {
    if (trimmed) {
      await result.locator('#trim-start-input').fill('1.3');
      await result.locator('#trim-start-input').press('Tab');
      await result.locator('#trim-end-input').fill('5.3');
      await result.locator('#trim-end-input').press('Tab');
    }
    for (const count of [2, 3, 4]) {
      await result.locator('#split-format-select').selectOption('webm');
      await result.locator(`[data-split-count="${count}"]`).click();
      await result.locator('#split-button').click();
      await expect(result.locator('#split-result-summary')).toHaveText(`나눈 파일 (${count}개)`, { timeout: 30_000 });
      await expect(result.locator('#split-button')).toBeEnabled();
      for (const button of await result.locator('#split-files-list button').all()) await button.click();
      const decoded = await decodeDownloads(result);
      expect(decoded).toEqual(Array(count).fill(true));
      await expectResultResourcesReleased(result, retainedUrls);
      expect(dialogs).toEqual([]);
    }
  }
  await result.locator('#speed-select').selectOption('2');
  await result.locator('#speed-convert-button').click();
  await expect.poll(() => result.evaluate(() => window.testDownloads.length), { timeout: 30_000 }).toBe(1);
  await expect(result.locator('#speed-convert-button')).toBeEnabled();
  expect(await decodeDownloads(result, 3)).toEqual([true]);
  await expectResultResourcesReleased(result, retainedUrls);
  await result.locator('[data-convert-format="gif"]').click();
  await expect.poll(() => result.evaluate(() => window.testDownloads.length), { timeout: 30_000 }).toBe(1);
  await expect(result.locator('[data-convert-format="gif"]')).toBeEnabled();
  expect(await result.evaluate(async () => Array.from(new Uint8Array(await
    (await window.testDownloads.splice(0)[0]).slice(0, 6).arrayBuffer())))).toEqual([71, 73, 70, 56, 57, 97]);
  await expectResultResourcesReleased(result, retainedUrls);
  await result.close();
  // Fail the third disk write after two complete MediaRecorder blobs were saved.
  await worker.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'chunks' && ++writes === 3) {
        IDBObjectStore.prototype.put = put;
        throw new DOMException('Injected disk failure', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  });
  await page.bringToFront();
  const recoveredPage = context.waitForEvent('page');
  await page.keyboard.press('e');
  const recovered = await recoveredPage;
  await expect(recovered.locator('#split-button')).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => recovered.locator('#preview-video').evaluate(video =>
    video.readyState >= 2 && video.videoWidth > 0 && video.duration > 0 && video.duration < 6)).toBe(true);
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
  expect(dialogs).toEqual([]);
});
