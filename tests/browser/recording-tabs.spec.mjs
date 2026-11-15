import { test, expect, prepareVideo } from './fixtures.mjs';
import { STARTUP_TRIM_MAX_SECONDS } from '../../dist/shared/types.js';

test('other tabs lock all recording controls and unlock after the owner stops', async ({ extension }) => {
  test.setTimeout(180000);
  const { context, page, worker } = extension;
  await prepareVideo(page);
  const other = await context.newPage();
  await other.route('https://chzzk.naver.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<body><div class="chzzk_player" style="width:800px;height:400px">
      <video style="width:800px;height:400px;display:block"></video>
      <div class="pzp-pc__bottom"><div class="pzp-pc__bottom-buttons-right"><button class="pzp-button">Native</button></div></div>
    </div></body>`,
  }));
  await other.goto('https://chzzk.naver.com/other-channel');
  await expect(other.locator('#crop-clip-chzzk-tool-button')).toBeAttached();
  const otherTabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chzzk.naver.com/other-channel' }))[0].id);
  const ownerTabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' }))[0].id);
  await worker.evaluate(async () => {
    const regions = Array.from({ length: 4 }, (_, index) => ({
      x: 80 + index % 2 * 400, y: 70 + Math.floor(index / 2) * 180, width: 300, height: 140,
      videoRelative: { x: 0.1 + index % 2 * 0.5, y: 0.175 + Math.floor(index / 2) * 0.45, width: 0.375, height: 0.35 },
    }));
    await chrome.storage.local.set({ region: regions[0], regions, settings: {
      enableShortcuts: true, enableFullRecordButton: true, enableMultiRegion: true, multiRegionMaxCount: 4,
    } });
  });
  const state = () => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState);
  const storedRegions = () => worker.evaluate(async () => (await chrome.storage.local.get(['region', 'regions'])));
  const initialRegions = await storedRegions();
  const sendFromTab = (tabId, messages) => worker.evaluate(async ({ tabId, messages }) => {
    const [execution] = await chrome.scripting.executeScript({ target: { tabId }, args: [messages], func: async messages => {
      const replies = [];
      for (const message of messages) replies.push(await chrome.runtime.sendMessage(message));
      return replies;
    } });
    return execution.result;
  }, { tabId, messages });
  const assertControls = async (mode, regionCount = 4) => {
    const buttons = other.locator('.crop-clip-border .record-region');
    await expect(buttons).toHaveCount(mode ? 0 : regionCount);
    for (const button of await buttons.all()) {
      await expect(button).toBeEnabled();
      await expect(button).not.toHaveAttribute('data-recording');
    }
    const select = other.locator('#crop-clip-chzzk-tool-button');
    if (mode) {
      await expect(select).toBeDisabled();
      await expect(select).toHaveAttribute('aria-label', '다른 탭에서 녹화 중');
    } else await expect(select).toBeEnabled();
    const full = other.locator('#crop-clip-chzzk-record-button');
    if (mode) {
      await expect(full).toHaveAttribute('aria-disabled', 'true');
      await expect(full).toHaveAttribute('aria-label', '다른 탭에서 녹화 중');
      await expect(full.locator('.pzp-ui-icon')).toHaveCSS('opacity', '0.42');
    }
    else await expect(full).toBeEnabled();
    await expect(other.locator('.cancel-recording:visible, #crop-clip-chzzk-cancel-button:visible')).toHaveCount(0);
  };
  await assertControls();

  for (const mode of ['full', 'region']) {
    await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
      // Background tabs may not receive an animation frame until focused.
      window.requestAnimationFrame = () => 0;
    } }), otherTabId);
    await page.bringToFront();
    const ownButton = page.locator(mode === 'full' ? '#crop-clip-chzzk-record-button' : '.crop-clip-border .record-region:visible');
    if (mode === 'region') {
      await other.bringToFront();
      await ownButton.evaluate(button => button.click());
    } else await ownButton.click({ timeout: 10000 });
    await expect(ownButton).toHaveAttribute('data-recording', '');
    const recording = await state();
    expect(recording.status).toBe('recording');
    expect(recording.tabId).toBe(ownerTabId);
    const started = Date.now();
    await assertControls(mode);
    await expect(ownButton).toBeEnabled();
    const ownSelect = page.locator('#crop-clip-chzzk-tool-button');
    await expect(ownSelect).toBeDisabled();
    await page.bringToFront();
    await ownSelect.hover();
    await expect(ownSelect.locator('.pzp-button__tooltip')).toHaveText('녹화 중에는 영역을 선택할 수 없습니다');
    await expect(ownSelect.locator('.pzp-button__tooltip')).toBeVisible();
    await ownSelect.dispatchEvent('pointerdown', { button: 0 });
    await expect(page.locator('#crop-clip-overlay')).toHaveCount(0);

    if (mode === 'full') {
      const regionRecord = page.locator('.crop-clip-border .record-region:visible');
      await expect(regionRecord).toBeDisabled();
      await expect(regionRecord).not.toHaveAttribute('disabled');
      await expect(regionRecord).toHaveAttribute('title', '전체 녹화 중에는 영역 녹화를 시작할 수 없습니다');
      await regionRecord.evaluate(button => button.click());
      const [first, second, ...remaining] = initialRegions.regions;
      const replies = await sendFromTab(ownerTabId, [
        { type: 'SAVE_REGIONS', regions: [{ ...first, x: first.x + 1 }, second, ...remaining] },
        { type: 'SAVE_REGIONS', regions: [second, first, ...remaining] },
      ]);
      for (const reply of replies) expect(reply).toMatchObject({ ok: false, error: /삭제만/ });
      expect(await storedRegions()).toEqual(initialRegions);
    } else {
      const fullRecord = page.locator('#crop-clip-chzzk-record-button');
      await expect(fullRecord).toBeDisabled();
      await fullRecord.hover();
      await expect(fullRecord.locator('.pzp-button__tooltip')).toHaveText('영역 녹화 중에는 전체 녹화를 시작할 수 없습니다');
      await expect(fullRecord.locator('.pzp-button__tooltip')).toBeVisible();
      await expect(page.locator('.crop-clip-border .clear-region').first()).toBeDisabled();
      await page.keyboard.press('x');
      await page.keyboard.press('z');
      expect(await storedRegions()).toEqual(initialRegions);
    }

    {
      const select = other.locator('#crop-clip-chzzk-tool-button');
      const tooltip = select.locator('.pzp-button__tooltip');
      await other.bringToFront();
      await other.mouse.move(0, 0);
      await expect(tooltip).toBeHidden();
      await select.hover();
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveText('다른 탭에서 녹화 중');
      const full = other.locator('#crop-clip-chzzk-record-button');
      await full.hover();
      await expect(full.locator('.pzp-button__tooltip')).toBeVisible();
      await expect(full.locator('.pzp-button__tooltip')).toHaveText('다른 탭에서 녹화 중');
      await other.mouse.down();
      await other.mouse.up();
      await full.focus();
      await other.keyboard.press('Enter');
      await expect(other.locator('#crop-clip-seek-feedback')).toHaveCount(0);
      await select.dispatchEvent('pointerdown', { button: 0 });
      await other.keyboard.press('a');
      await other.keyboard.press('x');
      await other.keyboard.press('z');
      await expect(other.locator('#crop-clip-overlay')).toHaveCount(0);

      const regionsBefore = await storedRegions();
      // Exercise the worker boundary even if the other tab's controls are stale.
      const replies = await sendFromTab(otherTabId, [
        { type: 'SELECT_REGION' },
        { type: 'SAVE_REGIONS', regions: [{ x: 150, y: 170, width: 200, height: 140 }] },
        { type: 'CLEAR_REGION' },
        { type: 'STOP_RECORDING' },
        { type: 'CANCEL_RECORDING' },
      ]);
      expect(replies).toHaveLength(5);
      for (const reply of replies) expect(reply).toMatchObject({ ok: false, error: /녹화 중/ });
      expect(await storedRegions()).toEqual(regionsBefore);
    }

    await other.keyboard.press('r');
    await other.keyboard.press('e');
    await other.keyboard.press('c');
    expect(await state()).toMatchObject({ status: 'recording', recordingId: recording.recordingId });
    await other.reload();
    await assertControls(mode);
    await expect(page.locator('.crop-clip-border')).toHaveCount(4);
    await expect(ownButton).toHaveAttribute('data-recording', '');

    if (mode === 'full') {
      await page.bringToFront();
      const clearRegion = page.locator('.crop-clip-border .clear-region').first();
      await expect(clearRegion).toBeEnabled();
      await clearRegion.click();
      await expect.poll(async () => (await storedRegions()).regions).toEqual(initialRegions.regions.slice(1));
      await page.keyboard.press('x');
      await expect.poll(async () => (await storedRegions()).regions).toEqual(initialRegions.regions.slice(2));

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
      await expect(popup.locator('#select-region-button')).toBeDisabled();
      await popup.locator('#clear-region-button').click();
      await expect.poll(storedRegions).toEqual({ region: null, regions: [] });
      await expect(page.locator('.crop-clip-border')).toHaveCount(0);
      expect(await state()).toMatchObject({ status: 'recording', recordingId: recording.recordingId });
      await popup.close();
    } else {
      await worker.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, enableMultiRegion: false } });
      });
      expect(await storedRegions()).toEqual(initialRegions);
      await expect(page.locator('.crop-clip-border')).toHaveCount(4);
    }

    // Exercise both recording paths with the user's usual 33-second clips.
    await page.waitForTimeout(Math.max(0, 33000 - (Date.now() - started)));
    await page.bringToFront();
    const opened = context.waitForEvent('page');
    await ownButton.click({ timeout: 10000 });
    const result = await opened;
    await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30000 });
    await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30000 });
    const startupTrimmed = mode === 'full' && (await result.locator('#split-status').textContent()) === '녹화 초반의 끊긴 구간을 제외했습니다.';
    // The cut can advance to the next keyframe, up to 1.25 seconds past the detected stall.
    const trimAllowance = startupTrimmed ? STARTUP_TRIM_MAX_SECONDS + 1.25 : 0;
    await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBeGreaterThan(32 - trimAllowance);
    await expect.poll(async () => (await state()).status).toBe('idle');
    if (mode === 'full') {
      expect(await storedRegions()).toEqual({ region: null, regions: [] });
      await worker.evaluate(regions => chrome.storage.local.set(regions), initialRegions);
    } else {
      await expect.poll(storedRegions).toEqual({ region: initialRegions.region, regions: initialRegions.regions.slice(0, 1) });
    }
    await assertControls(undefined, mode === 'full' ? 4 : 1);
    await expect(ownSelect).toBeEnabled();
    await result.close();
  }

  await worker.evaluate(() => chrome.storage.local.set({ region: null, regions: [] }));
  await expect(other.locator('.crop-clip-border')).toHaveCount(0);
  await other.bringToFront();
  await other.locator('#crop-clip-chzzk-tool-button').click();
  await expect(other.locator('#crop-clip-overlay')).toBeVisible();
  await other.mouse.move(100, 100);
  await other.mouse.down();
  await other.mouse.move(300, 240);
  await other.mouse.up();
  await expect.poll(async () => (await storedRegions()).regions.length).toBe(1);
  await expect(other.locator('#crop-clip-overlay')).toHaveCount(0);
});

test('the owner can queue stop and cancel while the region encoder starts', async ({ extension }) => {
  const { context, page, worker } = extension;
  await prepareVideo(page);
  await worker.evaluate(async () => {
    const region = { x: 80, y: 80, width: 250, height: 140 };
    await chrome.storage.local.set({ region, regions: [region] });
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (tabId, message, callback) => {
      if (message.type === 'START_DIRECT_RECORDING') {
        globalThis.releaseCaptureStart = () => {
          chrome.tabs.sendMessage = send;
          send(tabId, message, callback);
        };
        return;
      }
      return send(tabId, message, callback);
    };
  });

  const record = page.locator('.crop-clip-border .record-region');
  await record.click();
  await expect.poll(() => worker.evaluate(() => Boolean(globalThis.releaseCaptureStart))).toBe(true);
  try {
    await expect(record).toBeEnabled();
    await record.click();
    await expect(record).toHaveAttribute('aria-label', /시작 후 정지 예정/);
    await page.locator('.crop-clip-border .cancel-recording').click();
    await expect(record).toHaveAttribute('aria-label', /시작 후 취소 예정/);
  } finally {
    await worker.evaluate(() => globalThis.releaseCaptureStart());
  }
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
  await expect(record).toHaveAttribute('aria-busy', 'false');
  expect(context.pages().some(tab => tab.url().includes('/result/result.html'))).toBe(false);
});

test('rapid region deletions apply to the latest saved list', async ({ extension }) => {
  const { worker, page } = extension;
  const regions = [80, 320, 560].map(x => ({ x, y: 100, width: 200, height: 140 }));
  await worker.evaluate(regions => chrome.storage.local.set({
    region: regions[0], regions, settings: { enableMultiRegion: true, multiRegionMaxCount: 4 },
  }), regions);

  const buttons = page.locator('.crop-clip-border .clear-region');
  await expect(buttons).toHaveCount(3);
  await buttons.evaluateAll(([first, second]) => { first.click(); second.click(); });
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('regions')).regions)).toEqual(regions.slice(2));
  await expect(buttons).toHaveCount(1);
});
