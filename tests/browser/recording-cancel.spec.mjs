import { test, expect, prepareVideo } from './fixtures.mjs';

test('full recording cancellation releases encoders without a stop callback', async ({ extension }) => {
  test.setTimeout(90000);
  const { page, worker, context } = extension;
  await prepareVideo(page, 1920, 1080);
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' }))[0].id);
  const content = func => worker.evaluate(`(async () => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: (${String(func)}) });
    return result.result;
  })()`);
  await content(() => {
    const Recorder = MediaRecorder;
    window.__cancelledRecorders = [];
    window.__failNextStop = false;
    window.MediaRecorder = class extends Recorder {
      constructor(...args) {
        super(...args);
        __cancelledRecorders.push(this);
        // Model a busy browser that has not delivered the recording's stop callback.
        this.addEventListener('stop', event => event.stopImmediatePropagation(), { once: true });
      }
      stop() {
        if (__failNextStop) {
          __failNextStop = false;
          throw new DOMException('Encoder stop failed', 'InvalidStateError');
        }
        return super.stop();
      }
    };
  });
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('e');
    if (index % 2 === 0) await page.keyboard.press('c');
    await expect.poll(() => content(() => __cancelledRecorders.length)).toBe(index + 1);
    if (index % 2) {
      await page.waitForTimeout(1200); // Include encoders that have already saved a checkpoint.
      if (index === 7) await content(() => { __failNextStop = true; });
      await page.keyboard.press('c');
    }
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
    await expect(page.locator('#crop-clip-chzzk-record-button')).toHaveAttribute('aria-busy', 'false');
    const retained = await content(() => __cancelledRecorders.map(recorder => ({
      state: recorder.state,
      data: recorder.ondataavailable !== null,
      error: recorder.onerror !== null,
      stop: recorder.onstop !== null,
      tracks: recorder.stream.getTracks().length,
    })));
    expect(retained).toEqual(Array(index + 1).fill({ state: 'inactive', data: false, error: false, stop: false, tracks: 0 }));
  }
  expect(context.pages().filter(target => target.url().includes('/result/result.html'))).toHaveLength(0);
});
