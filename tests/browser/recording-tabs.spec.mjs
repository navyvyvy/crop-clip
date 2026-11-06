import { test, expect, prepareVideo } from './fixtures.mjs';

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
  const assertControls = async locked => {
    const buttons = other.locator('.crop-clip-border .record-region');
    await expect(buttons).toHaveCount(4);
    for (const button of await buttons.all()) {
      if (locked) {
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute('aria-label', /다른 탭/);
      } else await expect(button).toBeEnabled();
      await expect(button).not.toHaveAttribute('data-recording');
    }
    const full = other.locator('#crop-clip-chzzk-record-button');
    if (locked) await expect(full).toBeDisabled();
    else await expect(full).toBeEnabled();
    await expect(other.locator('.cancel-recording:visible, #crop-clip-chzzk-cancel-button:visible')).toHaveCount(0);
  };
  await assertControls(false);

  for (const mode of ['full', 'region']) {
    await page.bringToFront();
    const ownButton = page.locator(mode === 'full' ? '#crop-clip-chzzk-record-button' : '.crop-clip-border .record-region:visible');
    await ownButton.click({ timeout: 10000 });
    await expect(ownButton).toHaveAttribute('data-recording', '');
    const recording = await state();
    expect(recording.status).toBe('recording');
    const started = Date.now();
    await assertControls(true);
    await expect(ownButton).toBeEnabled();

    await other.keyboard.press('r');
    await other.keyboard.press('e');
    await other.keyboard.press('c');
    await other.locator('#crop-clip-chzzk-record-button').dispatchEvent('pointerdown', { button: 0 });
    expect(await state()).toMatchObject({ status: 'recording', recordingId: recording.recordingId });
    await other.reload();
    await assertControls(true);
    await expect(page.locator('.crop-clip-border')).toHaveCount(4);
    await expect(ownButton).toHaveAttribute('data-recording', '');

    // Exercise both recording paths with the user's usual 33-second clips.
    await page.waitForTimeout(Math.max(0, 33000 - (Date.now() - started)));
    await page.bringToFront();
    const opened = context.waitForEvent('page');
    await ownButton.click({ timeout: 10000 });
    const result = await opened;
    await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30000 });
    await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBeGreaterThan(32);
    await expect.poll(async () => (await state()).status).toBe('idle');
    await assertControls(false);
    await result.close();
  }
});
