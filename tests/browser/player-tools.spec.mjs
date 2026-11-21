import { test, expect, prepareVideo } from './fixtures.mjs';

async function updatePlayerSettings(worker, updates) {
  await worker.evaluate(async updates => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...updates } });
  }, updates);
}

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
