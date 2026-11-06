import { test, expect, prepareVideo } from './fixtures.mjs';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Opt-in: identical workloads can target a release build without running tests
// for the failure-recovery behavior that was deliberately changed after it.
test.skip(!process.env.CROPCLIP_PROFILE_REPORT, 'Set CROPCLIP_PROFILE_REPORT to save comparison measurements');
test('recording resource and performance profile', async ({ extension }, testInfo) => {
  const cancelMode = process.env.CROPCLIP_PROFILE_CANCEL === '1';
  const fullOnly = process.env.CROPCLIP_PROFILE_FULL === '1';
  const recordingSeconds = Number(process.env.CROPCLIP_PROFILE_SECONDS || 33);
  const cycles = Number(process.env.CROPCLIP_PROFILE_CYCLES || (cancelMode ? 32 : 8));
  expect(Number.isInteger(cycles) && cycles > 0 && cycles % 4 === 0).toBe(true);
  expect(Number.isFinite(recordingSeconds) && recordingSeconds >= 3).toBe(true);
  test.setTimeout(Math.max(240_000, cycles * (cancelMode ? 6000 : recordingSeconds * 1000 + 20000)));
  const { context, worker, page } = extension;
  const sourcePath = path.resolve('node_modules/.cache/cropclip-profile-source.webm');
  let source;
  try { source = await fs.readFile(sourcePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!source) {
    await prepareVideo(page, 1920, 1080);
    source = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch(document.querySelector('video').src)).arrayBuffer()))));
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, source);
  } else {
    await page.getByRole('button', { name: 'Native', exact: true }).click();
    await page.evaluate(async bytes => {
      await VideoEncoder.isConfigSupported({ codec: 'vp8', width: 1920, height: 1080, hardwareAcceleration: 'prefer-hardware' });
      const video = document.querySelector('video');
      video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/webm' }));
      video.loop = true;
      await video.play();
    }, Array.from(source));
  }
  await page.waitForTimeout(3000); // Warm the same decoded source before measuring either version.
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' }))[0].id);
  const content = (func, args = []) => worker.evaluate(`(async () => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: (${String(func)}), args: ${JSON.stringify(args)} });
    return result.result;
  })()`);
  await content(() => {
    const audit = { tracks: [], recorders: [], canvases: [], frames: [], captures: 0, starts: 0, flushes: 0, canvasContexts: 0 };
    globalThis.__recordingAudit = audit;
    const track = (value, kind) => { audit.tracks.push({ ref: new WeakRef(value), kind }); return value; };
    const createElement = document.createElement.bind(document);
    document.createElement = (...args) => {
      const element = createElement(...args);
      if (args[0] === 'canvas') audit.canvases.push(new WeakRef(element));
      return element;
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = getContext.apply(this, args);
      if (context) audit.canvasContexts++;
      return context;
    };
    if (typeof MediaStreamTrackGenerator === 'function') {
      const Generator = MediaStreamTrackGenerator;
      window.MediaStreamTrackGenerator = class extends Generator {
        constructor(options) { super(options); track(this, 'generator'); }
      };
    }
    const Frame = VideoFrame;
    window.VideoFrame = class extends Frame {
      constructor(...args) { super(...args); audit.frames.push(new WeakRef(this)); }
    };
    for (const [prototype, kind] of [[HTMLVideoElement.prototype, 'source'], [HTMLCanvasElement.prototype, 'canvas']]) {
      const capture = prototype.captureStream;
      prototype.captureStream = function (...args) {
        const stream = capture.apply(this, args);
        if (kind === 'source') audit.captures++;
        stream.getTracks().forEach(value => track(value, kind));
        return stream;
      };
    }
    const clone = MediaStreamTrack.prototype.clone;
    MediaStreamTrack.prototype.clone = function () { return track(clone.call(this), 'clone'); };
    const start = MediaRecorder.prototype.start;
    const requestData = MediaRecorder.prototype.requestData;
    MediaRecorder.prototype.requestData = function (...args) { audit.flushes++; return requestData.apply(this, args); };
    MediaRecorder.prototype.start = function (...args) {
      const result = start.apply(this, args);
      audit.recorders.push(new WeakRef(this)); audit.starts++; audit.startedAt = performance.now();
      return result;
    };
  });
  await worker.evaluate(() => {
    const region = { x: 100, y: 100, width: 400, height: 200, videoRelative: { x: 0.125, y: 0.25, width: 0.5, height: 0.5 } };
    return chrome.storage.local.set({ region, regions: [region] });
  });
  const cdp = await context.newCDPSession(page);
  const browserCdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  const snapshot = async (collected = true) => {
    const heapBeforeGc = (await metrics()).JSHeapUsedSize;
    if (collected) await cdp.send('HeapProfiler.collectGarbage');
    const performance = await metrics();
    const dom = await cdp.send('Memory.getDOMCounters');
    const processes = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
    const ids = processes.map(item => Number(item.id)).filter(Number.isInteger);
    const memory = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,PrivateMemorySize64,WorkingSet64,HandleCount | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }).trim());
    const byId = new Map([memory].flat().map(item => [item.Id, item]));
    const processMemory = processes.map(item => ({ type: item.type, id: item.id,
      privateBytes: byId.get(Number(item.id))?.PrivateMemorySize64 ?? 0,
      workingSetBytes: byId.get(Number(item.id))?.WorkingSet64 ?? 0,
      handles: byId.get(Number(item.id))?.HandleCount ?? 0,
    }));
    const privateBytes = processMemory.reduce((total, item) => total + item.privateBytes, 0);
    const tracks = await content(() => ({ captures: __recordingAudit.captures,
      canvasContexts: __recordingAudit.canvasContexts,
      flushes: __recordingAudit.flushes,
      retainedRecorders: __recordingAudit.recorders.filter(ref => ref.deref()).length,
      retainedCanvases: __recordingAudit.canvases.filter(ref => ref.deref()).length,
      retainedGenerators: __recordingAudit.tracks.filter(({ ref, kind }) => kind === 'generator' && ref.deref()).length,
      openFrames: __recordingAudit.frames.filter(ref => (ref.deref()?.codedWidth ?? 0) > 0).length,
      live: __recordingAudit.tracks.flatMap(({ ref, kind }) => {
      const value = ref.deref();
      return value?.readyState === 'live' ? [{ kind, type: value.kind, enabled: value.enabled }] : [];
    }) }));
    const targets = (await browserCdp.send('Target.getTargets')).targetInfos;
    return { collected, heapBeforeGc, heapBytes: performance.JSHeapUsedSize, privateBytes, processMemory, ...dom, tracks,
      dedicatedWorkers: targets.filter(target => target.type === 'worker').length };
  };
  const frames = () => page.locator('video').evaluate(video => {
    const quality = video.getVideoPlaybackQuality();
    return { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
  });
  const samples = [];
  const initial = await snapshot();
  for (let index = 0; index < cycles; index++) {
    const key = fullOnly || index % 2 === 0 ? 'e' : 'r';
    await page.bringToFront();
    const before = await metrics(), framesBefore = await frames();
    const start = await content(() => performance.now());
    await page.keyboard.press(key);
    if (cancelMode && index % 4 < 2) await page.keyboard.press('c');
    await expect.poll(() => content(() => __recordingAudit.starts)).toBe(index + 1);
    const startMs = await content(() => __recordingAudit.startedAt) - start;
    if (cancelMode) {
      if (index % 4 >= 2) {
        if (index % 4 === 3) await page.waitForTimeout(1200); // Include cancellation after a checkpoint.
        await page.keyboard.press('c');
      }
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
      await expect(page.locator('#crop-clip-chzzk-record-button')).toHaveAttribute('aria-busy', 'false');
      expect(context.pages().filter(target => target.url().includes('/result/result.html'))).toHaveLength(0);
      if ((index + 1) % 4) continue; // Run bursts without a GC or process-memory probe between cancellations.
      const resources = await snapshot();
      expect(resources.tracks.captures).toBe(1);
      expect(resources.tracks.flushes, 'cancel must not request a redundant data flush').toBe(0);
      expect(resources.tracks.live.filter(track => track.kind !== 'source' || track.type !== 'audio' || track.enabled)).toEqual([]);
      expect(resources.tracks.retainedRecorders, 'cancelled encoders must be collectible').toBe(0);
      expect(resources.tracks.retainedCanvases, 'cancelled canvases must be collectible').toBe(0);
      expect(resources.tracks.openFrames, 'cancel must close every native frame').toBe(0);
      expect(resources.tracks.retainedGenerators, 'cancelled generator tracks must be collectible').toBe(0);
      expect(resources.dedicatedWorkers).toBe(0);
      samples.push({ cancellations: index + 1, ...resources });
      continue;
    }
    // Real encoding time, not an arbitrary readiness wait.
    await page.waitForTimeout(recordingSeconds * 1000);
    const after = await metrics(), framesAfter = await frames();
    const opened = context.waitForEvent('page');
    const stopping = performance.now();
    await page.keyboard.press(key);
    const result = await opened;
    await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30_000 });
    const stopMs = performance.now() - stopping;
    await expect.poll(() => result.locator('#preview-video').evaluate((video, minimum) => video.readyState >= 2 && video.videoWidth > 0 && video.duration >= minimum, recordingSeconds - 1)).toBe(true);
    const beforeResultClose = await snapshot(false);
    await result.close();
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
    // Observe normal collection throughout recording/stop cycles; collect only at the end.
    const resources = await snapshot(index + 1 === cycles);
    samples.push({ mode: key === 'e' ? 'full' : 'region', recordingSeconds, startMs, stopMs,
      rendererTaskSeconds: after.TaskDuration - before.TaskDuration,
      frames: framesAfter.total - framesBefore.total, droppedFrames: framesAfter.dropped - framesBefore.dropped,
      beforeResultClose, ...resources });
    await fs.writeFile(process.env.CROPCLIP_PROFILE_REPORT, JSON.stringify({ initial, samples }, null, 2));
    console.log(JSON.stringify({ cycle: index + 1, collected: resources.collected,
      privateMiB: Math.round(resources.privateBytes / 1048576),
      processes: resources.processMemory.map(item => ({ type: item.type, privateMiB: Math.round(item.privateBytes / 1048576), handles: item.handles })),
      openFrames: resources.tracks.openFrames }));
    expect(resources.tracks.captures, 'reuse the original capture across sessions').toBe(1);
    expect(resources.tracks.live.filter(track => track.kind !== 'source' || track.type !== 'audio' || track.enabled)).toEqual([]);
    if (resources.collected) {
      expect(resources.tracks.retainedRecorders, 'stopped encoders must be collectible').toBe(0);
      expect(resources.tracks.retainedCanvases, 'stopped canvases must be collectible').toBe(0);
      expect(resources.tracks.retainedGenerators, 'stopped generator tracks must be collectible').toBe(0);
    }
    expect(resources.tracks.openFrames, 'stop must close every native frame').toBe(0);
    expect(resources.dedicatedWorkers, 'result close must release conversion workers').toBe(0);
  }
  if (cancelMode) {
    const stored = await worker.evaluate(async () => {
      // Count all stores: cancellation must not retain data from any earlier session.
      return await new Promise((resolve, reject) => {
        const request = indexedDB.open('cropClip');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, counts = {};
          const tx = db.transaction(['recordings', 'parts', 'chunks']);
          for (const name of ['recordings', 'parts', 'chunks']) {
            const count = tx.objectStore(name).count();
            count.onsuccess = () => { counts[name] = count.result; };
          }
          tx.oncomplete = () => { db.close(); resolve(counts); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
    });
    expect(stored).toEqual({ recordings: 0, parts: 0, chunks: 0 });
  }
  // Ignore first-use caches. This bounds retained JS, not GPU/native allocations.
  const collected = samples.filter(sample => sample.collected);
  const warmed = collected.length > 1 ? collected[0] : samples[0];
  expect(collected.at(-1).heapBytes - warmed.heapBytes).toBeLessThan(8 * 1024 * 1024);
  expect(collected.at(-1).nodes - warmed.nodes).toBeLessThan(100);
  expect(collected.at(-1).jsEventListeners - warmed.jsEventListeners).toBeLessThan(10);
  const report = { version: await worker.evaluate(() => chrome.runtime.getManifest().version),
    browser: process.env.CROPCLIP_TEST_BROWSER || 'chromium', mode: fullOnly ? 'full' : 'full and region', scenario: cancelMode ? `${cycles} start/cancel cycles in bursts of four` : `${cycles} record/stop cycles of ${recordingSeconds} seconds`, source: '1920x1080, 30fps', initial, samples };
  await fs.writeFile(process.env.CROPCLIP_PROFILE_REPORT, JSON.stringify(report, null, 2));
  await testInfo.attach('recording-profile', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});
