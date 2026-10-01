import { test, expect, prepareVideo, interceptDownloads, decodeDownloads, expectResultResourcesReleased } from './fixtures.mjs';

test('MP4 recording, splitting, speed, GIF and frame exports work', async ({ extension }) => {
  test.setTimeout(90_000);
  const { context, worker, page } = extension;
  await prepareVideo(page);
  await worker.evaluate(() => chrome.storage.local.set({ settings: {
    enableShortcuts: true, enableFullRecordButton: true, outputFormat: 'mp4',
  } }));
  await page.keyboard.press('e');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState?.status)).toBe('recording');
  await page.waitForTimeout(4000); // Produce real media for the split and decode checks.
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState >= 2 && video.duration > 3)).toBe(true);
  await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
  const retainedUrls = await result.evaluate(() => window.testObjectUrls.size);
  await interceptDownloads(result);
  for (const format of ['mp4', 'webm']) {
    await result.locator('#split-format-select').selectOption(format);
    await result.locator('[data-split-ratio="0.5"]').click();
    await result.locator('#split-button').click();
    await expect(result.locator('#split-result-summary')).toHaveText('나눈 파일 (2개)', { timeout: 30_000 });
    await expect(result.locator('#split-button')).toBeEnabled();
    for (const button of await result.locator('#split-files-list button').all()) await button.click();
    expect(await decodeDownloads(result)).toEqual([true, true]);
    await expectResultResourcesReleased(result, retainedUrls);
  }
  await result.locator('#speed-select').selectOption('2');
  await result.locator('#speed-convert-button').click();
  await expect.poll(() => result.evaluate(() => window.testDownloads.length), { timeout: 30_000 }).toBe(1);
  await expect(result.locator('#speed-convert-button')).toBeEnabled();
  expect(await decodeDownloads(result, 3)).toEqual([true]);
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
          args: ['-i', 'input.mp4', '-c:v', 'cropclip-test-invalid-codec', 'output.mp4'],
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
      await result.locator(count === 2 ? '[data-split-ratio="0.5"]' : `[data-split-count="${count}"]`).click();
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
