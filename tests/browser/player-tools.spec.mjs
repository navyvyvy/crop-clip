import { test, expect, prepareVideo } from './fixtures.mjs';

async function updatePlayerSettings(worker, updates) {
  await worker.evaluate(async updates => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...updates } });
  }, updates);
}

test('player controls return after the live room is rebuilt without navigation', async ({ extension }) => {
  const { page, worker } = extension;
  const room = `<div class="live-room"><div class="player-shell">
    <div class="chzzk_player" style="width:800px;height:400px">
      <video style="width:800px;height:400px;display:block"></video>
      <div class="pzp-pc__bottom"><div class="pzp-pc__bottom-buttons-right"><button class="pzp-button">Native</button></div></div>
    </div>
  </div></div>`;
  await updatePlayerSettings(worker, { enableFullScreenshotButton: true });
  await page.route('https://chzzk.naver.com/live/restart-test', route => route.fulfill({
    contentType: 'text/html', body: `<main>${room}<aside><div id="mini-slot"></div></aside></main>`,
  }));
  await page.goto('https://chzzk.naver.com/live/restart-test');

  const controls = page.locator('.pzp-pc__bottom-buttons-right');
  const selection = controls.getByRole('button', { name: '녹화 영역 선택' });
  const record = controls.locator('#crop-clip-chzzk-record-button');
  const capture = controls.locator('#crop-clip-chzzk-screenshot-button');
  await expect(selection).toBeVisible();
  await page.locator('#mini-slot').evaluate(slot => slot.append(document.querySelector('.live-room')));
  await expect(selection).toBeVisible();
  for (let restart = 0; restart < 2; restart++) {
    await page.locator('.live-room').evaluate(element => element.remove());
    await expect(selection).toHaveCount(0);
    await page.locator('#mini-slot').evaluate((element, markup) => element.insertAdjacentHTML('beforeend', markup), room);
    await expect(selection).toBeVisible();
    await expect(record).toBeVisible();
    await expect(capture).toBeVisible();
  }
  await page.locator('#mini-slot .live-room').evaluate(oldRoom => {
    oldRoom.hidden = true;
    const replacement = document.createElement('div');
    replacement.id = 'new-player-slot';
    oldRoom.parentElement.parentElement.append(replacement);
  });
  await page.locator('#new-player-slot').evaluate(slot => {
    const replacement = document.querySelector('#mini-slot .live-room').cloneNode(true);
    replacement.hidden = false;
    slot.append(replacement);
    replacement.querySelector('video').dispatchEvent(new Event('playing'));
  });
  await expect(page.locator('#crop-clip-chzzk-tool-button')).toHaveCount(1);
  await expect(record).toBeVisible();
  await expect(capture).toBeVisible();
  await selection.click();
  await expect(page.locator('#crop-clip-overlay')).toBeVisible();
});

test('a cloned player toolbar restores working controls', async ({ extension }) => {
  const { page } = extension;
  const selection = page.getByRole('button', { name: '녹화 영역 선택' });
  await expect(selection).toBeVisible();
  await page.locator('.chzzk_player').evaluate(player => player.replaceWith(player.cloneNode(true)));
  await selection.click();
  await expect(page.locator('#crop-clip-overlay')).toBeVisible();
});

test('a late region read cannot restore borders in the clip editor', async ({ extension }) => {
  const { page, worker } = extension;
  await worker.evaluate(async () => {
    const region = { x: 20, y: 20, width: 220, height: 120 };
    await chrome.storage.local.set({ region, regions: [region] });
  });
  const border = page.locator('.crop-clip-border');
  await expect(border).toBeVisible();
  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = async keys => {
        chrome.storage.local.get = get;
        await new Promise(resolve => {
          document.addEventListener('cropclip-finish-region-read', resolve, { once: true });
          document.documentElement.dataset.regionReadPending = '';
        });
        const state = await get(keys);
        requestAnimationFrame(() => { document.documentElement.dataset.regionReadFinished = ''; });
        return state;
      };
    } });
    return tab.id;
  });
  await page.evaluate(() => history.pushState({}, '', '/live/replacement'));
  await expect(page.locator('html')).toHaveAttribute('data-region-read-pending', '');
  await page.evaluate(() => history.pushState({}, '', '/clip-editor'));
  await expect(border).toHaveCount(0);
  await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    document.dispatchEvent(new Event('cropclip-finish-region-read'));
  } }), tabId);
  await expect(page.locator('html')).toHaveAttribute('data-region-read-finished', '');
  await expect(border).toHaveCount(0);
});

test('screenshots release their image data when the clip editor opens', async ({ extension }) => {
  test.setTimeout(90_000);
  const { page, worker } = extension;
  await prepareVideo(page);
  await updatePlayerSettings(worker, { enableFullScreenshotButton: true });

  const capture = page.locator('#crop-clip-chzzk-screenshot-button');
  const stack = page.locator('#crop-clip-screenshot-stack');
  const cards = stack.locator('.screenshot-card');
  const image = cards.first().locator('img');
  await expect(capture).toBeVisible();
  const urls = [];
  for (let index = 0; index < 10; index++) {
    await capture.click();
    await expect(cards).toHaveCount(Math.min(index + 1, 8));
    if (index > 0) await expect(image).not.toHaveAttribute('src', urls[index - 1]);
    urls.push(await image.getAttribute('src'));
  }
  const canReadImage = url => page.evaluate(url => fetch(url).then(response => response.ok, () => false), url);
  expect(await canReadImage(urls[0])).toBe(false);
  expect(await canReadImage(urls.at(-1))).toBe(true);
  await cards.first().getByRole('button', { name: '스크린샷 닫기' }).click();
  expect(await canReadImage(urls.at(-1))).toBe(false);

  const tabId = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, ...options) {
        HTMLCanvasElement.prototype.toBlob = toBlob;
        toBlob.call(this, blob => {
          globalThis.finishScreenshot = () => callback(blob);
          document.documentElement.setAttribute('data-pending-screenshot', '');
        }, ...options);
      };
    } });
    return tab.id;
  });
  const pendingCapture = worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_FULL_SCREENSHOT' }), tabId);
  await expect(page.locator('html')).toHaveAttribute('data-pending-screenshot', '');
  await page.evaluate(() => history.pushState({}, '', '/clip-editor'));
  await expect(capture).toHaveCount(0);
  await expect(stack).toHaveCount(0);
  for (const url of urls.slice(2, -1)) expect(await canReadImage(url)).toBe(false);

  await page.evaluate(() => history.pushState({}, '', '/extension-test'));
  await expect(capture).toBeVisible();
  await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const finish = globalThis.finishScreenshot;
    delete globalThis.finishScreenshot;
    finish();
  } }), tabId);
  expect(await pendingCapture).toMatchObject({ ok: false });
  await expect(stack).toHaveCount(0);
  await capture.click();
  await expect(cards).toHaveCount(1);
});

test('seek feedback shows the movement available at the beginning of the video', async ({ extension }) => {
  const { page, worker } = extension;
  await prepareVideo(page);
  await updatePlayerSettings(worker, { enableSeek: true, seekSeconds: 5 });

  const video = page.locator('video');
  await video.evaluate(video => {
    video.pause();
    video.currentTime = 0.4;
  });
  await expect.poll(() => video.evaluate(video => video.seeking)).toBe(false);
  const feedback = page.locator('#crop-clip-seek-feedback');
  await page.keyboard.press('ArrowLeft');
  await expect(feedback).toHaveText('-0.4초');
  expect(await video.evaluate(video => video.currentTime)).toBe(0);
  await expect.poll(() => video.evaluate(video => video.seeking)).toBe(false);
  await page.keyboard.press('ArrowLeft');
  await expect(feedback).toHaveText('0초');
});

test('full recording and screenshot shortcuts work with their buttons hidden', async ({ extension }) => {
  const { context, page, worker } = extension;
  await prepareVideo(page);
  await updatePlayerSettings(worker, { enableShortcuts: true, enableFullRecordButton: false, enableFullScreenshotButton: false });

  const record = page.locator('#crop-clip-chzzk-record-button');
  const screenshot = page.locator('#crop-clip-chzzk-screenshot-button');
  await expect(record).toHaveCount(0);
  await expect(screenshot).toHaveCount(0);
  await page.keyboard.press('d');
  await expect(page.locator('#crop-clip-screenshot-stack .screenshot-card')).toHaveCount(1);

  await page.keyboard.press('e');
  await expect(record).toHaveAttribute('data-recording', '');
  await expect(page.locator('#crop-clip-chzzk-record-time')).toBeVisible();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await expect(popup.getByRole('button', { name: '전체 정지', exact: true })).toBeVisible();
  await popup.close();

  await page.locator('#crop-clip-chzzk-cancel-button').click();
  await expect(record).toHaveCount(0);
  await expect(screenshot).toHaveCount(0);
});
