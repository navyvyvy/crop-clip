import { test, expect, prepareVideo, decodeDownloads, interceptDownloads } from './fixtures.mjs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

for (const rewind of [false, true]) test(rewind
  ? 'original recording uses the rewound fragment and returns to live after cancellation'
  : 'ready broadcast originals record without starting the screen encoder', async ({ extension }) => {
  test.setTimeout(90_000);
  const { context, page, worker } = extension;
  const generator = await context.newPage();
  await generator.goto(`chrome-extension://${new URL(worker.url()).host}/result/result.html`);
  const source = await generator.evaluate(async duration => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      const code = await ffmpeg.exec([
        '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${duration}`,
        '-f', 'lavfi', '-i', `sine=duration=${duration}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '240', '-sc_threshold', '0', '-c:a', 'aac',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof', 'source.mp4',
      ]);
      if (code !== 0) throw new Error('Could not encode the broadcast fixture');
      const blob = await readFfmpegBlob(ffmpeg, 'source.mp4', 'video/mp4');
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } finally { await releaseFfmpeg(); }
  }, rewind ? 16 : 8);
  const bytes = Buffer.from(source, 'base64');
  const fragments = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'moof') fragments.push(offset);
    const size = bytes.readUInt32BE(offset);
    if (size < 8) break;
    offset += size;
  }
  expect(fragments).toHaveLength(rewind ? 2 : 1);
  const [firstFragment, secondFragment = bytes.length] = fragments;
  const base = 'https://nvelop-slight-slit.pstatic.net/cropclip-startup-fixture';
  const playlist = (sequence, segment) => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:8,\n${segment}\n`;
  const files = {
    'live.m3u8': rewind ? playlist(2, 'latest.m4s') : playlist(1, 'first.m4s'),
    'rewind.m3u8': playlist(1, 'first.m4s'),
    'init.mp4': bytes.subarray(0, firstFragment),
    'first.m4s': bytes.subarray(firstFragment, secondFragment),
    'latest.m4s': bytes.subarray(secondFragment),
  };
  await page.route(`${base}/*`, route => route.fulfill({
    body: files[new URL(route.request().url()).pathname.split('/').at(-1)],
    headers: { 'Access-Control-Allow-Origin': 'https://chzzk.naver.com' },
  }));
  await page.bringToFront();
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  const video = page.locator('video');
  await video.evaluate(async (video, { source, base, rewind }) => {
    history.pushState({}, '', '/live/original-startup-fixture');
    const media = new MediaSource();
    video.src = URL.createObjectURL(media);
    await new Promise(resolve => media.addEventListener('sourceopen', resolve, { once: true }));
    const buffer = media.addSourceBuffer('video/mp4; codecs="avc1.42c00c,mp4a.40.2"');
    const appended = new Promise(resolve => buffer.addEventListener('updateend', resolve, { once: true }));
    buffer.appendBuffer(Uint8Array.from(atob(source), byte => byte.charCodeAt(0)));
    await appended;
    video.currentTime = rewind ? 8.5 : 0.5;
    await video.play();
    await (await fetch(`${base}/live.m3u8?_HLS_msn=${rewind ? 2 : 1}`)).text();
  }, { source, base, rewind });
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, enableOriginalStreamRecording: true } });
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/live/original-startup-fixture' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      document.documentElement.dataset.screenRecorderStarts = '0';
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        const html = document.documentElement;
        html.dataset.screenRecorderStarts = String(Number(html.dataset.screenRecorderStarts) + 1);
        return start.apply(this, args);
      };
    } });
  });
  const readState = () => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState);
  const readFirstChunk = recordingId => generator.evaluate(async id => {
    const { getChunksByRecordingId } = await import('/shared/idb.js');
    const [chunk] = await getChunksByRecordingId(id);
    return chunk?.originalStreamStart ?? -1;
  }, recordingId);
  if (rewind) {
    const seekAndLoad = (time, path) => video.evaluate(async (video, { time, url }) => {
      const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      video.currentTime = time;
      await seeked;
      await (await fetch(url)).text();
    }, { time, url: `${base}/${path}` });
    await seekAndLoad(0.75, 'rewind.m3u8');
    await page.evaluate(async base => { await (await fetch(`${base}/live.m3u8?_HLS_msn=2`)).text(); }, base);
    await page.keyboard.press('e');
    await expect(page.locator('#crop-clip-seek-feedback')).toHaveText('원본 저장 중');
    const { recordingId: cancelledId } = await readState();
    await expect.poll(() => readFirstChunk(cancelledId)).toBeGreaterThanOrEqual(0.75);
    expect(await readFirstChunk(cancelledId)).toBeLessThan(8);
    await page.keyboard.press('c');
    await expect.poll(async () => (await readState()).status).toBe('idle');
    await expect.poll(() => readFirstChunk(cancelledId)).toBe(-1);
    await seekAndLoad(8.5, 'live.m3u8?_HLS_msn=2');
    const recordButton = page.locator('#crop-clip-chzzk-record-button');
    await expect(recordButton).toHaveAttribute('aria-busy', 'false');
    await expect(recordButton).not.toHaveAttribute('data-recording', '');
  }
  const before = await video.evaluate(video => video.currentTime);
  await page.keyboard.press('e');
  await expect(page.locator('#crop-clip-seek-feedback')).toHaveText('원본 저장 중');
  if (!rewind) await expect(page.locator('html')).toHaveAttribute('data-screen-recorder-starts', '0');
  const { recordingId, startedAt } = await readState();
  expect(startedAt).toBeGreaterThan(0);
  await expect.poll(() => readFirstChunk(recordingId)).toBeGreaterThanOrEqual(before - 0.05);
  const originalStart = await readFirstChunk(recordingId);
  await generator.close();
  await expect.poll(() => video.evaluate(video => video.currentTime)).toBeGreaterThan(originalStart + 1.1);
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#video-codec')).toHaveText('· H.264');
  const saved = await result.evaluate(async () => {
    const { getPartsByRecordingId, getRecording } = await import('/shared/idb.js');
    const id = new URL(location.href).searchParams.get('id');
    const [recording, [part]] = await Promise.all([getRecording(id), getPartsByRecordingId(id)]);
    return { createdAt: recording.createdAt, method: part.captureMethod };
  });
  expect(saved.method).toBe('original');
  expect(saved.createdAt).toBe(startedAt);
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBeGreaterThan(0.9);
  const download = result.waitForEvent('download');
  await result.locator('#download-current-button').click();
  const output = await fs.readFile(await (await download).path());
  const opening = await result.evaluate(async base64 => {
    const { loadFfmpeg, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      await ffmpeg.writeFile('clip.mp4', Uint8Array.from(atob(base64), byte => byte.charCodeAt(0)));
      await ffmpeg.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries',
        'frame=best_effort_timestamp_time', '-of', 'json', '-o', 'frames.json', 'clip.mp4'], 4000);
      const { frames } = JSON.parse(await ffmpeg.readFile('frames.json', 'utf8'));
      return frames.map(frame => Number(frame.best_effort_timestamp_time)).filter(time => time >= 0).slice(0, 12);
    } finally { await releaseFfmpeg(); }
  }, output.toString('base64'));
  expect(opening).toHaveLength(12);
  expect(opening[0]).toBeLessThan(0.04);
  expect(Math.max(...opening.slice(1).map((time, index) => time - opening[index]))).toBeLessThan(0.04);
});

// Reproduce runners that can record H.264 but cannot encode AAC.
test.beforeEach(async ({ extension }) => {
  if (!process.env.CROPCLIP_TEST_WITHOUT_AAC) return;
  const { worker } = extension;
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const Recorder = MediaRecorder;
      const supports = Recorder.isTypeSupported.bind(Recorder);
      Recorder.isTypeSupported = type => !type.includes('mp4a') && supports(type);
      window.MediaRecorder = class extends Recorder {
        constructor(stream, options) {
          super(stream, options);
          document.documentElement.dataset.testRecorderMime = options.mimeType;
        }
      };
    } });
  });
});

async function observeRecordingStartup(worker, holdHardwareDiscovery = false) {
  await worker.evaluate(async hold => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [hold], func: hold => {
      const timing = globalThis.cropClipStartupTiming = { probes: [], starts: [] };
      const probe = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = async config => {
        if (!config.codec.startsWith('avc1')) return probe(config);
        const sample = { began: performance.now(), finished: null };
        timing.probes.push(sample);
        try {
          if (hold) await new Promise(resolve => { globalThis.cropClipReleaseHardwareDiscovery = resolve; });
          return await probe(config);
        }
        finally { sample.finished = performance.now(); }
      };
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        const sample = { began: performance.now(), firstChunk: null, mimeType: this.mimeType, engine: 'media-recorder' };
        timing.starts.push(sample);
        this.addEventListener('dataavailable', event => {
          if (sample.firstChunk === null && event.data.size > 0) sample.firstChunk = performance.now();
        });
        start.apply(this, args);
      };
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args) {
        if (message?.type === 'prepare' && globalThis.cropClipRejectSoftwarePreparation) {
          document.documentElement.dataset.softwarePreparationRejected = '';
          throw new Error('Injected software recorder preparation failure');
        }
        if (message?.type === 'start' && message.tracks?.video) {
          const sample = { began: performance.now(), firstChunk: null, mimeType: '', engine: 'software' };
          timing.starts.push(sample);
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'started') sample.mimeType = data.mimeType;
            if (data.type === 'chunk' && sample.firstChunk === null && data.blob.size > 0) sample.firstChunk = performance.now();
          });
        }
        return post.call(this, message, ...args);
      };
    } });
  }, holdHardwareDiscovery);
}

async function readRecordingStartup(worker, url = 'https://chzzk.naver.com/extension-test') {
  return worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: () => globalThis.cropClipStartupTiming,
    });
    return result;
  }, url);
}

test('recording keeps the opening frames when the display clock is rounded', async ({ extension }) => {
  const { worker, page } = extension;
  await prepareVideo(page, 320, 180, 4500);
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      // The canvas path makes each selected frame observable without encoder timing jitter.
      globalThis.MediaStreamTrackGenerator = undefined;
      const sampleCount = 30;
      let observed = 0;
      let painted = 0;
      let sampling = false;
      const getQuality = HTMLVideoElement.prototype.getVideoPlaybackQuality;
      HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
        // Edge can report the same quality count for several newly presented frames.
        return sampling ? { totalVideoFrames: Math.floor((observed - 1) / 3) * 3 } : getQuality.call(this);
      };
      const fill = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function (...args) {
        if (sampling) painted++;
        return fill.apply(this, args);
      };
      const request = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return request.call(this, (now, metadata) => {
          if (observed >= sampleCount) return callback(now, metadata);
          const index = observed++;
          const expectedDisplayTime = 40 + Math.floor((index * 100 / 3) / 10) * 10;
          sampling = true;
          try {
            callback(now, { ...metadata, expectedDisplayTime, mediaTime: 12 + index / 30 });
          } finally {
            sampling = false;
          }
          if (observed === sampleCount) document.documentElement.dataset.openingFramesPainted = String(painted);
        });
      };
    } });
  });
  const recordButton = page.locator('#crop-clip-chzzk-record-button');
  await page.keyboard.press('e');
  await expect(recordButton).toHaveAttribute('data-recording', '');
  await expect(page.locator('html')).toHaveAttribute('data-opening-frames-painted', '30');
  await page.keyboard.press('c');
  await expect(recordButton).not.toHaveAttribute('data-recording', '');
});

for (const [format, label] of [['webm', 'WebM'], ['mp4', 'MP4']]) test(`${label} recording keeps middle frames when timer sampling is delayed`, async ({ extension }, testInfo) => {
  test.setTimeout(150_000);
  const { context, worker, page } = extension;
  const sourcePath = process.env.CROPCLIP_CONTINUITY_SOURCE;
  const originalEnabled = Boolean(sourcePath) && process.env.CROPCLIP_STARTUP_ORIGINAL === 'on';
  const softwareExpected = Boolean(sourcePath) && process.env.CROPCLIP_SOFTWARE_CAPTURE === '1';
  const source = sourcePath ? (await fs.readFile(sourcePath)).toString('base64') : await makeContinuitySource(context, worker, 60);
  if (softwareExpected) await observeRecordingStartup(worker);
  if (originalEnabled) await page.evaluate(() => history.pushState({}, '', '/live/continuity-fixture'));
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.locator('video').evaluate(async (video, base64) => {
    const bytes = Uint8Array.from(atob(base64), byte => byte.charCodeAt(0));
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    window.testSourceGaps = [];
    let previous;
    const observe = (now, { presentedFrames, mediaTime }) => {
      if (previous !== undefined && now - previous >= 60) window.testSourceGaps.push({ now, gap: now - previous, mediaTime });
      previous = now;
      window.testSourceFrames = presentedFrames;
      video.requestVideoFrameCallback(observe);
    };
    video.requestVideoFrameCallback(observe);
    await video.play();
  }, source);
  await worker.evaluate(async ({ outputFormat, originalEnabled, hasSource }) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, outputFormat, enableOriginalStreamRecording: originalEnabled,
      videoBitsPerSecond: hasSource ? 8_000_000 : 16_000_000 } });
  }, { outputFormat: format, originalEnabled, hasSource: Boolean(sourcePath) });
  if (sourcePath) await worker.evaluate(async ({ url, originalEnabled }) => {
    if (originalEnabled) {
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = options => options.world === 'MAIN'
        ? new Promise(resolve => setTimeout(() => resolve([{ result: { ok: false } }]), options.args?.[2] ? 0 : 5000))
        : execute(options);
    }
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      globalThis.cropClipContinuityWrites = [];
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, ...args) => {
        if (message.type !== 'STORE_RECORDING_CHUNK') return send(message, ...args);
        const start = performance.now();
        const result = send(message, ...args);
        cropClipContinuityWrites.push({ start, duration: performance.now() - start, encodedBytes: message.chunk.dataUrl.length });
        return result;
      };
    } });
  }, { url: page.url(), originalEnabled });
  if (!sourcePath) await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const setInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay !== 33) return setInterval(callback, delay, ...args);
        const started = performance.now();
        return setInterval(() => {
          const elapsed = performance.now() - started;
          if ((elapsed >= 3200 && elapsed < 3500) || (elapsed >= 16_000 && elapsed < 16_300)
            || (elapsed >= 30_000 && elapsed < 30_300)) return;
          callback(...args);
        }, delay);
      };
    } });
  });
  const playbackClock = () => page.locator('video').evaluate(video => ({
    time: video.currentTime, wall: performance.now() / 1000, timeOrigin: performance.timeOrigin,
    frames: window.testSourceFrames ?? 0,
  }));
  const clicked = await playbackClock();
  await page.keyboard.press('e');
  const recordingStartedAt = () => worker.evaluate(async () =>
    (await chrome.storage.local.get('recordingState')).recordingState?.startedAt ?? 0);
  await expect.poll(recordingStartedAt, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator('#crop-clip-chzzk-record-button')).toHaveAttribute('data-recording', '');
  const startedAt = await recordingStartedAt();
  if (softwareExpected) {
    expect((await readRecordingStartup(worker, page.url())).starts.map(sample => sample.engine)).toEqual(['software']);
  }
  if (format === 'mp4' && process.env.CROPCLIP_TEST_WITHOUT_AAC) {
    await expect(page.locator('html')).toHaveAttribute('data-test-recorder-mime', /avc1,opus/);
  }
  const start = await playbackClock();
  await page.waitForTimeout(33_000);
  const end = await playbackClock();
  const playedSeconds = end.time - start.time;
  expect(Math.abs(playedSeconds - (end.wall - start.wall))).toBeLessThan(0.5);
  const sourceGaps = await page.evaluate(({ start, end }) => window.testSourceGaps
    .filter(({ now }) => now >= start && now <= end)
    .map(({ now, gap, mediaTime }) => ({ at: (now - start) / 1000, gap, mediaTime })), {
    start: clicked.wall * 1000, end: end.wall * 1000,
  });
  const captureStart = startedAt - clicked.timeOrigin;
  const openingWrites = sourcePath && await worker.evaluate(async ({ url, start }) => {
    const [tab] = await chrome.tabs.query({ url });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [start], func: start =>
      cropClipContinuityWrites.filter(item => item.start - start <= 10_000).map(item => ({ ...item, start: (item.start - start) / 1000 })),
    });
    return result;
  }, { url: page.url(), start: captureStart });
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30000 });
  if (originalEnabled) await expect(result.locator('#capture-fallback')).toBeVisible();
  else await expect(result.locator('#capture-fallback')).toBeHidden();
  const preparationStatus = await result.locator('#split-status').textContent();
  const savedTiming = await result.evaluate(async () => {
    const { getRecording } = await import('/shared/idb.js');
    const recording = await getRecording(new URLSearchParams(location.search).get('id'));
    return { createdAt: recording?.createdAt, endedAt: recording?.endedAt };
  });
  const downloaded = result.waitForEvent('download');
  await result.locator('#download-current-button').click();
  const bytes = await fs.readFile(await (await downloaded).path());
  const { video, audio, decodeResult, freezeReport } = await inspectContinuityDownload(result, bytes, format);
  const videoSeconds = video.at(-1) - video[0];
  const audioSeconds = audio.at(-1).end - audio[0].start;
  const trackEnds = { video: video.at(-1), audio: audio.at(-1).end };
  const recordingSeconds = (savedTiming.endedAt - startedAt) / 1000;
  if (format === 'webm') expect(savedTiming.createdAt).toBe(startedAt);
  const videoGaps = video.slice(1).map((time, index) => ({ at: video[index] - video[0], gap: time - video[index] }));
  const worstVideoGap = videoGaps.reduce((worst, frame) => frame.gap > worst.gap ? frame : worst, { at: 0, gap: 0 });
  const videoMaxGap = worstVideoGap.gap;
  const audioMaxGap = Math.max(0, ...audio.slice(1).map((frame, index) => frame.start - audio[index].end));
  const openingVideoMaxGaps = Array.from({ length: 10 }, (_, second) =>
    Math.max(0, ...videoGaps.filter(frame => Math.floor(frame.at) === second).map(frame => frame.gap)));
  const timingPath = testInfo.outputPath('download-timing.json');
  await fs.writeFile(timingPath, JSON.stringify({
    originalEnabled, playedSeconds, sourceFrames: end.frames - start.frames, videoSeconds, audioSeconds, videoMaxGap, audioMaxGap,
    videoFrames: video.length, openingVideoMaxGaps, worstVideoGap, freezeReport, sourceGaps, openingWrites,
    startDelaySeconds: captureStart / 1000 - clicked.wall, recordingSeconds, startedAt, savedTiming, preparationStatus, trackEnds,
  }, null, 2));
  await testInfo.attach('download-timing.json', {
    path: timingPath,
    contentType: 'application/json',
  });
  if (!sourcePath && format === 'mp4' && Math.abs(trackEnds.video - trackEnds.audio) >= 0.25) {
    await fs.writeFile(testInfo.outputPath('mp4-track-timing-failure.mp4'), bytes);
  }
  expect(decodeResult, 'the downloaded video and audio must decode to the end').toBe(0);
  expect(freezeReport, 'the moving picture must not freeze, even if packets keep arriving').toBe('');
  expect(Math.abs(videoSeconds - recordingSeconds), 'the downloaded video must preserve the recording interval').toBeLessThan(1);
  expect(Math.abs(video[0] - audio[0].start), 'picture and sound must start together').toBeLessThan(0.15);
  expect(Math.abs(trackEnds.video - trackEnds.audio), 'picture and sound must end together').toBeLessThan(0.25);
  expect(video.length / videoSeconds, 'the 30fps source must retain its frame rate').toBeGreaterThan(25);
  expect(openingVideoMaxGaps.every(gap => gap > 0), 'each of the first ten seconds must contain decoded video').toBe(true);
  expect(videoMaxGap, 'the downloaded picture must stay continuous from start to end').toBeLessThan(0.12);
  expect(audioMaxGap, 'the downloaded sound must stay continuous from start to end').toBeLessThan(0.08);
});

async function makeContinuitySource(context, worker, duration = 45, videoFilter = 'testsrc2=size=320x180:rate=30') {
  const generator = await context.newPage();
  await generator.goto(`chrome-extension://${new URL(worker.url()).host}/result/result.html`);
  try { return await generator.evaluate(async ({ duration, videoFilter }) => {
    const { loadFfmpeg, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      const code = await ffmpeg.exec(['-f', 'lavfi', '-i', videoFilter,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(duration),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', 'source.mp4']);
      if (code !== 0) throw new Error('Continuity fixture encoding failed');
      const bytes = await ffmpeg.readFile('source.mp4');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return btoa(binary);
    } finally { await releaseFfmpeg(); }
  }, { duration, videoFilter }); } finally { await generator.close(); }
}

function sampleColorBars(video) {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const samples = [];
  for (const y of [25, 80]) {
    for (const x of [8, 30, 50, 65, 80, 95, 110, 130, 150]) {
      const patch = [[], [], []];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const offset = ((y + dy) * canvas.width + x + dx) * 4;
          for (let channel = 0; channel < 3; channel++) patch[channel].push(data[offset + channel]);
        }
      }
      for (const channel of patch) {
        channel.sort((a, b) => a - b);
        samples.push(channel[Math.floor(channel.length / 2)]);
      }
    }
  }
  return samples;
}

for (const [format, label] of [['webm', 'WebM'], ['mp4', 'MP4']]) test(`${label} download preserves the source playback colors`, async ({ extension }, testInfo) => {
  const { context, page, worker } = extension;
  const source = await makeContinuitySource(context, worker, 4, 'smptehdbars=size=1920x1080:rate=30');
  await worker.evaluate(async outputFormat => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, outputFormat, enableOriginalStreamRecording: false } });
  }, format);
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  const video = page.locator('video');
  await video.evaluate(async (element, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0));
    element.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    element.loop = true;
    await element.play();
  }, source);
  const expected = await video.evaluate(sampleColorBars);
  await page.keyboard.press('e');
  const button = page.locator('#crop-clip-chzzk-record-button');
  await expect(button).toHaveAttribute('data-recording', '');
  await expect(button).toHaveAttribute('aria-busy', 'false');
  await page.waitForTimeout(2000);
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30_000 });
  const downloading = result.waitForEvent('download');
  await result.locator('#download-current-button').click();
  const bytes = await fs.readFile(await (await downloading).path());
  await result.evaluate(async ({ format, encoded }) => {
    const clip = document.createElement('video');
    clip.id = 'test-saved-clip';
    clip.muted = true;
    clip.style.cssText = 'position:fixed;top:0;left:0;width:160px;height:90px';
    document.body.append(clip);
    const bytes = Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0));
    clip.src = URL.createObjectURL(new Blob([bytes], { type: `video/${format}` }));
    await clip.play();
    await new Promise(resolve => clip.requestVideoFrameCallback(resolve));
  }, { format, encoded: bytes.toString('base64') });
  const actual = await result.locator('#test-saved-clip').evaluate(sampleColorBars);
  const differences = actual.map((channel, index) => Math.abs(channel - expected[index]));
  const maxDifference = Math.max(...differences);
  if (maxDifference > 8) {
    await testInfo.attach(`downloaded.${format}`, { body: bytes, contentType: `video/${format}` });
  }
  expect(maxDifference, `downloaded color bars ${actual} should match ${expected}`).toBeLessThanOrEqual(8);
});

async function inspectContinuityDownload(result, bytes, format) {
  return result.evaluate(async ({ base64, format }) => {
    const { loadFfmpeg, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const bytes = Uint8Array.from(atob(base64), byte => byte.charCodeAt(0));
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      const filename = `recording.${format}`;
      await ffmpeg.writeFile(filename, bytes);
      const video = [];
      const audio = [];
      ffmpeg.on('log', ({ message }) => {
        // MP4 edit lists can retain negative-time packets that the player decodes but never displays.
        const picture = /Parsed_showinfo_.*\bn:\s*\d+.*\bpts_time:\s*([\d.eE+-]+)/.exec(message);
        if (picture) video.push(Number(picture[1]));
        const frame = /\bpts_time:([\d.eE+-]+).*\brate:(\d+)\s+nb_samples:(\d+)/.exec(message);
        if (!frame) return;
        const start = Number(frame[1]);
        audio.push({ start, end: start + Number(frame[3]) / Number(frame[2]) });
      });
      const decodeResult = await ffmpeg.exec(['-v', 'info', '-xerror', '-copyts', '-i', filename, '-map', '0:v:0', '-map', '0:a:0',
        '-af', 'ashowinfo',
        '-vf', 'showinfo,freezedetect=n=-60dB:d=0.18,metadata=mode=print:key=lavfi.freezedetect.freeze_start:file=freezes.txt',
        '-f', 'null', '-'], 45_000);
      const freezeReport = decodeResult === 0 ? await ffmpeg.readFile('freezes.txt', 'utf8') : '';
      return { video, audio, decodeResult, freezeReport };
    } finally { await releaseFfmpeg(); }
  }, { base64: bytes.toString('base64'), format });
}

for (const blockRenderer of [false, true]) test(blockRenderer
  ? 'WebM download repairs a dropped interval and preserves the recorded file'
  : 'WebM keeps recording when foreground frame callbacks are delayed', async ({ extension }, testInfo) => {
  test.setTimeout(100_000);
  const { context, worker, page } = extension;
  const source = await makeContinuitySource(context, worker);
  await worker.evaluate(async blockRenderer => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, outputFormat: 'webm', enableOriginalStreamRecording: false } });
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [blockRenderer], func: blockRenderer => {
      let startedAt = Infinity;
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        this.addEventListener('start', () => {
          startedAt = performance.now();
          if (blockRenderer) setTimeout(() => {
            const deadline = performance.now() + 800;
            while (performance.now() < deadline) { /* Block both capture callbacks and the fallback timer. */ }
            document.documentElement.dataset.recordingThreadStall = 'true';
          }, 6700);
        }, { once: true });
        return start.apply(this, args);
      };
      const playbackQuality = HTMLVideoElement.prototype.getVideoPlaybackQuality;
      let lastReportedFrames = 0;
      HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
        const quality = playbackQuality.call(this);
        const elapsed = performance.now() - startedAt;
        if (elapsed >= 5000 && elapsed < 9500) {
          document.documentElement.dataset.staleRecordingCounter = 'true';
          return { totalVideoFrames: lastReportedFrames };
        }
        lastReportedFrames = quality.totalVideoFrames;
        return quality;
      };
      const request = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        const deliver = (now, metadata) => {
          const elapsed = now - startedAt;
          if (elapsed >= 5000 && elapsed < 9500 && elapsed % 1000 < 450) {
            const data = document.documentElement.dataset;
            data.withheldRecordingFrames = String(Number(data.withheldRecordingFrames ?? '0') + 1);
            request.call(this, deliver);
            return;
          }
          callback(now, metadata);
        };
        return request.call(this, deliver);
      };
    } });
  }, blockRenderer);
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.locator('video').evaluate(async (video, base64) => {
    const bytes = Uint8Array.from(atob(base64), byte => byte.charCodeAt(0));
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    await video.play();
  }, source);
  await page.keyboard.press('e');
  await expect.poll(() => worker.evaluate(async () =>
    (await chrome.storage.local.get('recordingState')).recordingState?.startedAt ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  const playbackStart = await page.locator('video').evaluate(video => video.currentTime);
  await page.waitForTimeout(11_000);
  expect(await page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(playbackStart + 10);
  expect(Number(await page.locator('html').getAttribute('data-withheld-recording-frames'))).toBeGreaterThan(40);
  await expect(page.locator('html')).toHaveAttribute('data-stale-recording-counter', 'true');
  if (blockRenderer) await expect(page.locator('html')).toHaveAttribute('data-recording-thread-stall', 'true');
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30_000 });
  const downloaded = result.waitForEvent('download');
  await result.locator('#download-current-button').click();
  const bytes = await fs.readFile(await (await downloaded).path());
  const { video, audio, decodeResult, freezeReport } = await inspectContinuityDownload(result, bytes, 'webm');
  let removedSeconds = 0;
  if (blockRenderer) {
    const saved = await result.evaluate(async () => {
      const { getPartsByRecordingId } = await import('/shared/idb.js');
      const [part] = await getPartsByRecordingId(new URLSearchParams(location.search).get('id'));
      const { loadFfmpeg, releaseFfmpeg } = await import('/result/ffmpeg.js');
      const ffmpeg = await loadFfmpeg(() => {});
      try {
        const inspectFrames = async (blob, name) => {
          if (!blob) throw Error('Missing video before or after gap repair');
          await ffmpeg.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
          const output = `${name}.frames`;
          const code = await ffmpeg.exec(['-v', 'error', '-xerror', '-i', name, '-map', '0:v:0', '-fps_mode', 'passthrough',
            '-enc_time_base', '-1', '-f', 'framemd5', output]);
          if (code !== 0) throw Error('Unable to hash decoded video frames');
          const report = await ffmpeg.readFile(output, 'utf8');
          const [, timeBaseNumerator, timeBaseDenominator] = /^#tb 0:\s*(\d+)\/(\d+)/m.exec(report);
          const rows = report.split('\n').filter(line => /^\s*\d\s*,/.test(line)).map(line => line.split(','));
          const span = (Number(rows.at(-1)[2]) - Number(rows[0][2])) * Number(timeBaseNumerator) / Number(timeBaseDenominator);
          return { span, hashes: rows.map(row => row.at(-1).trim()) };
        };
        const originalVideo = await inspectFrames(part.originalBlob, 'raw.webm');
        const repairedVideo = await inspectFrames(part.blob, 'repaired.webm');
        return { originalSize: part.originalBlob?.size, removed: part.removedVideoGapSeconds, size: part.blob.size,
          frames: originalVideo.hashes.length, repairedFrames: repairedVideo.hashes.length, removedFromTimeline: originalVideo.span - repairedVideo.span,
          sameVideo: originalVideo.hashes.length === repairedVideo.hashes.length
            && originalVideo.hashes.every((hash, index) => hash === repairedVideo.hashes[index]) };
      } finally { await releaseFfmpeg(); }
    });
    expect(saved.originalSize).toBeGreaterThan(0);
    expect(saved.removed).toBeGreaterThan(0.7);
    expect(Math.abs(saved.removed - saved.removedFromTimeline)).toBeLessThan(0.08);
    removedSeconds = saved.removed;
    expect(saved.size).toBe(bytes.length);
    expect(saved.frames).toBeGreaterThan(200);
    expect(saved.sameVideo, `automatic repair must preserve decoded frames (${saved.frames} → ${saved.repairedFrames})`).toBe(true);
    expect(Math.abs(video.at(-1) - audio.at(-1).end)).toBeLessThan(0.15);
  }
  const gaps = video.slice(1).map((time, index) => ({ at: video[index] - video[0], gap: time - video[index] }));
  const middleGaps = gaps.filter(({ at }) => at >= 3 && at < 9.5);
  const maxGap = Math.max(...middleGaps.map(({ gap }) => gap));
  const timingPath = testInfo.outputPath('middle-frame-gaps.json');
  await fs.writeFile(timingPath, JSON.stringify({ maxGap, gaps: middleGaps.filter(({ gap }) => gap > 0.07) }, null, 2));
  await testInfo.attach('middle-frame-gaps.json', { path: timingPath, contentType: 'application/json' });
  expect(decodeResult).toBe(0);
  expect(freezeReport).toBe('');
  expect(video.at(-1) - video[0] + removedSeconds).toBeGreaterThan(10);
  expect(maxGap).toBeLessThan(blockRenderer ? 0.18 : 0.085);
});

test('MP4 recording uses H.265 only for a confirmed H.265 source', async ({ extension }, testInfo) => {
  test.setTimeout(120_000);
  const { context, worker, page } = extension;
  await prepareVideo(page, 1920, 1080, 6500);
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const Recorder = MediaRecorder;
      window.MediaRecorder = class extends Recorder {
        constructor(stream, options) {
          super(stream, options);
          document.documentElement.dataset.captureBitrate = `${options.videoBitsPerSecond}/${this.videoBitsPerSecond}`;
        }
      };
    } });
  });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  const codec = popup.getByRole('radiogroup', { name: '녹화 코덱' });
  const hevc = codec.getByRole('radio', { name: 'H.265' });
  await expect(hevc).toBeDisabled();
  await popup.getByRole('radiogroup', { name: '저장 형식' }).getByText('MP4', {exact:true}).click();
  const sourceMime = await popup.evaluate(async () => {
    const { HEVC_MP4_MIME_TYPES } = await import('/shared/types.js');
    return HEVC_MP4_MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type) && MediaSource.isTypeSupported(type));
  });
  await expect(hevc).toBeEnabled();
  await codec.getByText('H.265', {exact:true}).click();
  const bitrateInput = popup.locator('#custom-video-bitrate-input');
  await bitrateInput.fill('16');
  await bitrateInput.press('Tab');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings)).toMatchObject({
    outputFormat: 'mp4', recordingCodec: 'hevc', videoBitsPerSecond: 16_000_000,
  });
  await popup.close();

  const inputs = sourceMime ? [undefined, sourceMime] : [undefined];
  for (const inputMime of inputs) {
    await page.bringToFront();
    if (inputMime) await prepareVideo(page, 1920, 1080, 6500, inputMime);
    await page.keyboard.press('e');
    await expect(page.locator('#crop-clip-chzzk-record-button')).toHaveAttribute('data-recording', '');
    await expect(page.locator('html')).toHaveAttribute('data-capture-bitrate', '16000000/16000000');
    await page.waitForTimeout(4100);
    const opened = context.waitForEvent('page');
    await page.keyboard.press('e');
    const result = await opened;
    await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30000 });
    const saved = await result.evaluate(async () => {
      const { getPartsByRecordingId } = await import('/shared/idb.js');
      const [part] = await getPartsByRecordingId(new URL(location.href).searchParams.get('id'));
      const { loadFfmpeg, releaseFfmpeg } = await import('/result/ffmpeg.js');
      const ffmpeg = await loadFfmpeg(() => {});
      try {
        await ffmpeg.writeFile('capture.mp4', new Uint8Array(await part.blob.arrayBuffer()));
        await ffmpeg.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', '-o', 'capture.json', 'capture.mp4'], 4000);
        const { streams } = JSON.parse(await ffmpeg.readFile('capture.json', 'utf8'));
        return { mimeType: part.mimeType, ...streams[0] };
      } finally { await releaseFfmpeg(); }
    });
    expect(saved.mimeType).toMatch(inputMime ? /hvc1|hev1/ : /avc1/);
    expect(saved).toMatchObject({ codec_name: inputMime ? 'hevc' : 'h264', width: 1920, height: 1080 });
    await expect(result.locator('#video-codec')).toHaveText(inputMime ? '· H.265' : '· H.264');
    await expect(result.locator('#video-codec')).toBeVisible();
    await testInfo.attach(`result-codec-${saved.codec_name}.json`, {
      body: JSON.stringify(saved), contentType: 'application/json',
    });
    await expect(result.locator('#preview-video')).toBeVisible();
    if (inputMime || !sourceMime) {
      await interceptDownloads(result);
      await result.locator('[data-split-count="2"]').click();
      await result.locator('#split-button').click();
      const downloads = result.locator('#split-files-list button');
      await expect(downloads).toHaveCount(2);
      await expect(downloads.first()).toBeEnabled();
      for (const button of await downloads.all()) await button.click();
      expect(await decodeDownloads(result)).toEqual([true, true]);
    }
    await result.close();
  }
});

test('playing video prepares H.264 once before recording without starting an encoder', async ({ extension }) => {
  const { worker, page } = extension;
  test.skip(!await page.evaluate(() => typeof VideoEncoder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=avc1')),
    'Requires H.264 WebM recording support');
  await observeRecordingStartup(worker);
  await prepareVideo(page);
  await expect.poll(async () => (await readRecordingStartup(worker)).probes[0]?.finished, { timeout: 16000 }).toEqual(expect.any(Number));
  expect((await readRecordingStartup(worker)).starts).toHaveLength(0);

  const button = page.locator('#crop-clip-chzzk-record-button');
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'false');
  await expect(button).toHaveAttribute('data-recording', '');
  const timing = await readRecordingStartup(worker);
  expect(timing.probes).toHaveLength(1);
  expect(timing.starts).toHaveLength(1);
  expect(timing.starts[0].began).toBeGreaterThan(timing.probes[0].finished);
  await page.keyboard.press('c');
  await expect(button).not.toHaveAttribute('data-recording', '');
});

const softwareStartupTest = process.env.CROPCLIP_SOFTWARE_CAPTURE === '1' ? test : test.skip;
softwareStartupTest('software recording starts before native discovery and waits for it only on fallback', async ({ extension }) => {
  const { worker, page } = extension;
  await observeRecordingStartup(worker, true);
  await prepareVideo(page, 1920, 1080, 2100);
  const button = page.locator('#crop-clip-chzzk-record-button');
  await expect.poll(async () => (await readRecordingStartup(worker)).probes.length).toBe(1);
  await page.keyboard.press('e');
  await expect.poll(async () => (await readRecordingStartup(worker)).starts[0]?.firstChunk).toEqual(expect.any(Number));
  let timing = await readRecordingStartup(worker);
  expect(timing.starts[0].engine).toBe('software');
  expect(timing.probes[0].finished).toBeNull();
  await page.keyboard.press('c');
  await expect(button).not.toHaveAttribute('data-recording', '');
  await expect(button).toHaveAttribute('aria-busy', 'false');
  const transfer = release => worker.evaluate(async release => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [release], func: release => {
      if (release) globalThis.cropClipReleaseHardwareDiscovery();
      else globalThis.cropClipRejectSoftwarePreparation = true;
    } });
  }, release);
  await transfer(false);
  await page.keyboard.press('e');
  await expect(page.locator('html')).toHaveAttribute('data-software-preparation-rejected', '');
  timing = await readRecordingStartup(worker);
  expect(timing.starts).toHaveLength(1);
  expect(timing.probes[0].finished).toBeNull();
  await transfer(true);
  await expect.poll(async () => (await readRecordingStartup(worker)).starts[1]?.firstChunk).toEqual(expect.any(Number));
  timing = await readRecordingStartup(worker);
  expect(timing.starts[1].engine).toBe('media-recorder');
  expect(timing.starts[1].began).toBeGreaterThan(timing.probes[0].finished);
  await page.keyboard.press('c');
  await expect(button).not.toHaveAttribute('data-recording', '');
});

const startupTimingTest = process.env.CROPCLIP_STARTUP_REPORT ? test : test.skip;
startupTimingTest('first recording frame timing', async ({ extension }) => {
  test.setTimeout(90_000);
  const { worker, page } = extension;
  const regionMode = process.env.CROPCLIP_STARTUP_MODE === 'region';
  const outputFormat = process.env.CROPCLIP_STARTUP_FORMAT === 'mp4' ? 'mp4' : 'webm';
  const originalEnabled = !regionMode && process.env.CROPCLIP_STARTUP_ORIGINAL === 'on';
  await worker.evaluate(async settingsToTest => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...settingsToTest } });
  }, { outputFormat, enableOriginalStreamRecording: originalEnabled });
  if (regionMode) await worker.evaluate(() => {
    const region = { x: 400, y: 200, width: 400, height: 200, videoRelative: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };
    return chrome.storage.local.set({ region, regions: [region] });
  });
  const button = page.locator(regionMode ? '.crop-clip-border .record-region' : '#crop-clip-chzzk-record-button');
  // Generate this source with recording-profile.spec.mjs first; encoding it in this
  // browser would warm the encoder and invalidate the first-start measurement.
  const sourcePath = process.env.CROPCLIP_STARTUP_SOURCE || 'node_modules/.cache/cropclip-profile-source.webm';
  const source = await fs.readFile(sourcePath);
  const captureMode = process.env.CROPCLIP_STARTUP_CAPTURE || 'default';
  if (captureMode !== 'default') await worker.evaluate(async mode => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [mode], func: mode => {
      if (mode === 'canvas') globalThis.MediaStreamTrackGenerator = undefined;
      if (mode === 'vp8') {
        const supports = MediaRecorder.isTypeSupported.bind(MediaRecorder);
        MediaRecorder.isTypeSupported = mime => !mime.includes('avc1') && supports(mime);
      }
    } });
  }, captureMode);
  await observeRecordingStartup(worker);
  if (originalEnabled) await page.evaluate(() => history.pushState({}, '', '/live/startup-timing-fixture'));
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.evaluate(async ({ encoded, mimeType }) => {
    const video = document.querySelector('video');
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    video.src = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    video.loop = true;
    await video.play();
    const frames = window.__startupFrames = [];
    const tick = (now, { mediaTime }) => {
      frames.push({ now, mediaTime });
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }, { encoded: source.toString('base64'), mimeType: sourcePath.endsWith('.mp4') ? 'video/mp4' : 'video/webm' });
  const samples = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    // Give the cold capability check time to finish during ordinary viewing.
    await page.waitForTimeout(cycle === 0 ? 8000 : 1500);
    const start = await page.evaluate(() => performance.now());
    await page.keyboard.press(regionMode ? 'r' : 'e');
    await expect(button).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
    await expect(button).toHaveAttribute('data-recording', '');
    await page.waitForTimeout(2000); // Include encoder startup and the first checkpoint.
    const timing = await readRecordingStartup(worker, page.url());
    const recording = timing.starts[cycle];
    const startup = await page.evaluate(start => {
      const frames = window.__startupFrames;
      const gaps = frames.slice(1).map(({ now, mediaTime }, index) => ({
        time: now,
        gap: now - frames[index].now,
        mediaGap: Math.max(0, (mediaTime - frames[index].mediaTime) * 1000),
      }));
      const baseline = gaps.filter(frame => frame.time >= start - 1000 && frame.time < start);
      const startup = gaps.filter(frame => frame.time >= start);
      const worst = startup.reduce((longest, frame) => frame.gap > longest.gap ? frame : longest, { gap: 0, time: start, mediaGap: 0 });
      return { baselineMaxGap: Math.max(...baseline.map(frame => frame.gap)),
        startupMaxGap: Math.max(...startup.map(frame => frame.gap)), startupMaxGapAt: worst.time - start,
        mediaGapAtWorstDisplayGap: worst.mediaGap };
    }, start);
    samples.push({
      cycle, ...startup, mimeType: recording.mimeType, engine: recording.engine,
      clickToRecorderStart: recording.began - start,
      clickToFirstChunk: recording.firstChunk === null ? null : recording.firstChunk - start,
      probesAfterClick: timing.probes.filter(sample => sample.began >= start && sample.began <= recording.began).length,
      ...(cycle === 0 ? { firstProbe: timing.probes[0] && {
        beganFromClick: timing.probes[0].began - start,
        finishedFromClick: timing.probes[0].finished - start,
      } } : {}),
    });
    await page.keyboard.press('c');
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
    await expect(page.locator('#crop-clip-chzzk-record-button')).toHaveAttribute('aria-busy', 'false');
  }
  await fs.writeFile(process.env.CROPCLIP_STARTUP_REPORT, JSON.stringify({ mode: regionMode ? 'region' : 'full', captureMode, outputFormat, originalEnabled, samples }, null, 2));
  console.log(JSON.stringify(samples));
  // Keep the actual failure visible when explicitly running this diagnostic.
  for (const sample of samples) {
    expect(Number.isFinite(sample.baselineMaxGap) && Number.isFinite(sample.startupMaxGap), 'both intervals must contain video frames').toBe(true);
    expect(sample.clickToFirstChunk, 'timing must include a recording that actually produced data').toEqual(expect.any(Number));
    if (process.env.CROPCLIP_SOFTWARE_CAPTURE === '1') expect(sample.engine).toBe('software');
  }
  expect(samples[0].startupMaxGap, 'the first recording must not stall playback for 100ms').toBeLessThan(100);
});

test('a recording with audio before its first video frame opens on video', async ({ extension }) => {
  const { worker, context } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  await result.goto(base);
  const id = await result.evaluate(async () => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const { putRecording, putPart } = await import('/shared/idb.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      const filename = 'delayed-video.mp4';
      const code = await ffmpeg.exec([
        '-itsoffset', '0.133333', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=2',
        '-f', 'lavfi', '-i', 'sine=duration=2.133333', '-c:v', 'libx264', '-preset', 'ultrafast', '-fps_mode', 'passthrough',
        '-c:a', 'aac', '-use_editlist', '1', filename,
      ]);
      if (code !== 0) throw Error('Could not encode a delayed video track');
      const blob = await readFfmpegBlob(ffmpeg, filename, 'video/mp4');
      const id = crypto.randomUUID(), createdAt = Date.now();
      await putRecording({ id, createdAt, endedAt: createdAt + 2133, actualExtension: 'mp4', totalSize: blob.size });
      await putPart({ id: `${id}:part:001`, recordingId: id, index: 1, filename, extension: 'mp4',
        mimeType: blob.type, size: blob.size, blob, createdAt, inspectStartup: true });
      return id;
    } finally { await releaseFfmpeg(); }
  });
  await result.goto(`${base}?id=${id}`);
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30000 });
  await expect(result.locator('#split-status')).toHaveText('녹화 초반의 끊긴 구간을 제외했습니다.');
  const download = result.waitForEvent('download');
  await result.locator('#download-current-button').click();
  const output = await fs.readFile(await (await download).path());
  const start = await result.evaluate(async base64 => {
    const { loadFfmpeg, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      await ffmpeg.writeFile('clip.mp4', Uint8Array.from(atob(base64), byte => byte.charCodeAt(0)));
      await ffmpeg.ffprobe(['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', '-o', 'streams.json', 'clip.mp4'], 4000);
      const { streams } = JSON.parse(await ffmpeg.readFile('streams.json', 'utf8'));
      return Object.fromEntries(streams.map(stream => [stream.codec_type, Number(stream.start_time)]));
    } finally { await releaseFfmpeg(); }
  }, output.toString('base64'));
  expect(Math.abs(start.video - start.audio)).toBeLessThan(0.04);
});

for (const [format, scenario] of [['webm', 'early'], ['webm', 'late'], ['mp4', 'early'], ['webm', 'continuous'], ['webm', 'short-video']]) test({
  early: format === 'webm' ? 'WebM repairs opening gaps without cutting its first frame' : 'mp4 download inspects opening timestamps even without a capture stall marker',
  late: 'WebM repairs a gap after half a second without changing its start time',
  continuous: 'WebM download preserves a continuous opening despite a capture stall marker',
  'short-video': 'WebM startup trim preserves the source when only the audio has enough duration',
}[scenario], async ({ extension }) => {
  const { worker, context } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  await result.goto(base);
  const id = await result.evaluate(async ({ format, scenario }) => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const { putRecording, putPart } = await import('/shared/idb.js');
    const ffmpeg = await loadFfmpeg(() => {});
    const filename = `startup_20261126_123456.${format}`;
    const continuous = scenario === 'continuous';
    const shortVideo = scenario === 'short-video';
    const openingDuration = continuous || shortVideo ? 1.4 : scenario === 'late' ? 0.7 : format === 'webm' ? 0.16 : 1;
    const keepFrames = continuous || shortVideo ? '1' : scenario === 'late' ? 'not(between(n,18,20))'
      : format === 'webm' ? 'not(between(n,1,2)+eq(n,4))' : 'if(lt(t,1),not(mod(n,3)),1)';
    let blob;
    try {
      const withAudio = shortVideo || (format === 'webm' && !continuous);
      const code = await ffmpeg.exec([
        '-f', 'lavfi', '-i', `color=red:size=160x90:rate=30:duration=${openingDuration}`,
        '-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=30:duration=${shortVideo ? 0.4 : 1.3}`,
        ...(withAudio ? ['-f', 'lavfi', '-i', `sine=duration=${shortVideo ? 2.7 : openingDuration + 1.3}`, '-map', '2:a:0', '-c:a', 'libvorbis'] : []),
        '-filter_complex', `[0:v][1:v]concat=n=2:v=1:a=0[joined];[joined]select='${keepFrames}'[v]`, '-map', '[v]', '-fps_mode', 'vfr',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', scenario === 'late' ? '30' : '240', '-sc_threshold', '0',
        '-f', format === 'webm' ? 'matroska' : 'mp4', filename,
      ]);
      if (code !== 0) throw Error('Startup fixture encoding failed');
      blob = await readFfmpegBlob(ffmpeg, filename, `video/${format}`);
    } finally { await releaseFfmpeg(); }
    const id = crypto.randomUUID(), createdAt = Date.now();
    await putRecording({ id, createdAt, endedAt: createdAt + openingDuration * 1000 + 1300, totalSize: blob.size, actualExtension: format });
    await putPart({ id: `${id}:part:001`, recordingId: id, index: 1, filename, extension: format,
      mimeType: blob.type, size: blob.size, blob, createdAt, videoBitsPerSecond: 8_500_000, inspectStartup: shortVideo ? undefined : true,
      startupTrimSeconds: continuous || shortVideo ? 1.4 : undefined, seekMetadataVersion: 1 });
    return id;
  }, { format, scenario });
  if (format === 'webm' && scenario !== 'continuous') {
    await context.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args) {
        const ffmpegArgs = message?.data?.args;
        if (message?.type === 'EXEC' && ffmpegArgs?.at(-1) === 'output-gap-repaired.webm') {
          window.testStartupVideoCodec = ffmpegArgs[ffmpegArgs.indexOf('-c:v') + 1];
        }
        return post.call(this, message, ...args);
      };
    });
  }
  await result.goto(`${base}?id=${id}`);
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30000 });
  if (scenario === 'short-video') {
    await expect(result.locator('#split-status')).toBeEmpty();
    await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBeCloseTo(2.7, 1);
    expect(await result.evaluate(() => window.testStartupVideoCodec)).toBeUndefined();
    await expect(result.locator('#download-current-button')).toBeEnabled();
    return;
  }
  if (scenario === 'continuous') {
    await expect(result.locator('#split-status')).toBeEmpty();
    await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBeCloseTo(2.7, 1);
    const download = result.waitForEvent('download');
    await result.locator('#download-current-button').click();
    expect((await download).suggestedFilename()).toMatch(/_3s\.webm$/);
    return;
  }
  if (format === 'webm') {
    expect(await result.evaluate(() => window.testStartupVideoCodec)).toBe('copy');
    const { unchangedStart, removedGapSeconds } = await result.evaluate(async id => {
      const { getPartsByRecordingId, getRecording } = await import('/shared/idb.js');
      const [recording, [part]] = await Promise.all([getRecording(id), getPartsByRecordingId(id)]);
      return { unchangedStart: recording.createdAt === part.createdAt, removedGapSeconds: part.removedVideoGapSeconds };
    }, id);
    expect(unchangedStart).toBe(true);
    expect(removedGapSeconds).toBeGreaterThan(0.05);
    expect(removedGapSeconds).toBeLessThan(0.15);
  }
  const downloaded = result.waitForEvent('download');
  await result.locator('#download-current-button').click();
  const bytes = await fs.readFile(await (await downloaded).path());
  const frames = await result.evaluate(async ({ data, format }) => {
    const video = document.createElement('video');
    const blob = new Blob([Uint8Array.from(atob(data), byte => byte.charCodeAt(0))], { type: `video/${format}` });
    const url = URL.createObjectURL(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    const frame = () => {
      ctx.drawImage(video, 0, 0, 160, 90);
      return ctx.getImageData(0, 0, 160, 90).data;
    };
    try {
      const loaded = new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
      video.src = url;
      await loaded;
      if (format === 'webm') {
        const openingFrame = new Promise(resolve => { video.onseeked = resolve; });
        video.currentTime = 0.045;
        await openingFrame;
      }
      const first = frame();
      const seeked = new Promise(resolve => { video.onseeked = resolve; });
      video.currentTime = format === 'webm' ? 0.95 : 0.35;
      await seeked;
      const next = frame();
      let redPixels = 0, changedPixels = 0;
      for (let index = 0; index < first.length; index += 4) {
        if (first[index] > 200 && first[index + 1] < 55 && first[index + 2] < 55) redPixels++;
        if (Math.abs(first[index] - next[index]) > 25 || Math.abs(first[index + 1] - next[index + 1]) > 25
          || Math.abs(first[index + 2] - next[index + 2]) > 25) changedPixels++;
      }
      const pixels = first.length / 4;
      return { openingRedShare: redPixels / pixels, changedShare: changedPixels / pixels, duration: video.duration };
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }, { data: bytes.toString('base64'), format });
  expect(frames.changedShare).toBeGreaterThan(0.025);
  expect(frames.duration).toBeGreaterThan(0.9);
  if (format === 'webm') {
    expect(frames.openingRedShare, 'retain the original first frame').toBeGreaterThan(0.9);
    expect(frames.duration).toBeCloseTo(scenario === 'late' ? 1.9 : 1.393, 1);
    const { video, audio, decodeResult } = await inspectContinuityDownload(result, bytes, format);
    expect(decodeResult).toBe(0);
    expect(Math.max(...video.slice(1).map((time, index) => time - video[index]))).toBeLessThan(0.09);
    expect(Math.abs(video[0] - audio[0].start)).toBeLessThan(0.08);
    expect(Math.abs(video.at(-1) - audio.at(-1).end)).toBeLessThan(0.1);
  } else {
    expect(frames.openingRedShare).toBeLessThan(0.9);
    expect(frames.duration).toBeLessThan(1.5);
  }
  if (format === 'mp4') {
    await result.evaluate(async id => {
      const { getPartsByRecordingId, putPart } = await import('/shared/idb.js');
      const [part] = await getPartsByRecordingId(id);
      await putPart({ ...part, startupTrimSeconds: 1.1 });
    }, id);
    const previous = await worker.evaluate(async id => {
      await chrome.storage.local.set({ recordingState: { status: 'completed', recordingId: id } });
      return (await chrome.downloads.search({})).length;
    }, id);
    await result.goto(`${base}?id=${id}&autoDownload=1`);
    await expect(result.locator('#split-status')).toHaveText(/초반 끊김을 정리하지 못했습니다/);
    await expect(result.locator('#download-current-button')).toBeEnabled();
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
    expect(await worker.evaluate(async () => (await chrome.downloads.search({})).length)).toBe(previous);
  }
});

async function verifyStartupDownload(page, bytes, format, capture) {
  const saved = await page.evaluate(async recordingId => {
    const { getPartsByRecordingId, getRecording } = await import('/shared/idb.js');
    const [recording, [part]] = await Promise.all([getRecording(recordingId), getPartsByRecordingId(recordingId)]);
    const hash = await crypto.subtle.digest('SHA-256', await part.blob.arrayBuffer());
    return { startedAt: recording.createdAt, removedGapSeconds: part.removedVideoGapSeconds, hash: Array.from(new Uint8Array(hash)) };
  }, capture.recordingId);
  if (format === 'webm') {
    expect(saved.startedAt).toBe(capture.startedAt);
    expect(saved.removedGapSeconds).toBeGreaterThan(0.15);
  } else {
    expect(saved.startedAt - capture.startedAt, 'the download must trim the injected opening stall').toBeGreaterThan(150);
  }
  expect(createHash('sha256').update(bytes).digest()).toEqual(Buffer.from(saved.hash));
  const { video, decodeResult } = await inspectContinuityDownload(page, bytes, format);
  expect(decodeResult, 'the download must decode through the end').toBe(0);
  expect(video.at(-1) - video[0], 'the download must retain the playable part of the recording').toBeGreaterThan(2);
  const opening = video.filter(time => time - video[0] < 1);
  expect(opening.length).toBeGreaterThan(10);
  expect(Math.max(...opening.slice(1).map((time, index) => time - opening[index]))).toBeLessThan(0.18);
}

for (const format of ['webm', 'mp4']) test(format === 'webm'
  ? 'full H.264 WebM recordings preserve their start after an opening stall'
  : 'full H.264 mp4 recordings exclude a stalled opening and keep short originals', async ({ extension }, testInfo) => {
  test.setTimeout(120_000);
  const { worker, page, context } = extension;
  await prepareVideo(page);
  const supported = format === 'webm' ? ['video/webm;codecs=avc1']
    : ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1,mp4a.40.2"', 'video/mp4;codecs="avc1,opus"'];
  expect(await page.evaluate(types => types.some(type => MediaRecorder.isTypeSupported(type)), supported),
    `The release browser must support H.264 recording in ${format}`).toBe(true);
  await worker.evaluate(async outputFormat => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, outputFormat: outputFormat === 'webm' ? 'mp4' : 'webm', enableOriginalStreamRecording: false } });
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        start.apply(this, args);
        window.setTimeout(() => {
          const end = performance.now() + 360;
          while (performance.now() < end) { /* Stall the first capture interval. */ }
        }, 60);
      };
    } });
  }, format);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
  await expect(popup.locator('input[name="output-format"]:checked')).toHaveValue(format === 'webm' ? 'mp4' : 'webm');
  await popup.getByRole('radiogroup', { name: '저장 형식' })
    .getByText(format === 'webm' ? 'WebM' : 'MP4', { exact: true }).click();
  await popup.locator('label:has(input[name="original-stream-mode"][value="on"])').click();
  await expect.poll(() => worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    return [settings.outputFormat, settings.enableOriginalStreamRecording];
  })).toEqual([format, true]);
  await popup.close();
  await context.addInitScript(() => {
    window.startupInspections = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'FFPROBE' && message.data?.args?.some(arg =>
        arg === 'output-startup-probe.json' || arg === 'output-gap-probe.json')) window.startupInspections++;
      return post.call(this, message, ...args);
    };
  });
  const cases = [
    { duration: 5000, status: format === 'webm' ? /끊긴 구간을 정리/ : /끊긴 구간을 제외/ },
    { duration: 450, original: true },
  ];
  cases.push({ duration: 5000, automatic: true, original: true });
  for (const { duration, status, automatic, original = false } of cases) {
    await worker.evaluate(async enableOriginalStreamRecording => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, enableOriginalStreamRecording } });
    }, original);
    const previousDownloadIds = automatic
      ? await worker.evaluate(async () => (await chrome.downloads.search({})).map(item => item.id))
      : [];
    if (automatic) {
      const downloads = testInfo.outputPath('automatic');
      await fs.mkdir(downloads, { recursive: true });
      const session = await context.newCDPSession(page);
      await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      await context.addInitScript(() => {
        if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.downloads) return;
        const download = chrome.downloads.download.bind(chrome.downloads);
        chrome.downloads.download = async options => {
          await chrome.storage.local.set({ testAutoDownloadFilename: options.filename });
          return download(options);
        };
      });
      await worker.evaluate(async () => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, enableAutoDownloadRecording: true, autoFocusResult: false } });
      });
    }
    await page.bringToFront();
    // Keep the injected opening stall away from the fixture's three-second loop seek.
    await page.evaluate(async () => {
      const video = document.querySelector('video');
      if (video.currentTime < 0.05) return;
      const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      video.currentTime = 0;
      await seeked;
    });
    await page.keyboard.press('e');
    const button = page.locator('#crop-clip-chzzk-record-button');
    await expect(button).toHaveAttribute('data-recording', '', { timeout: 20000 });
    await expect(button).toHaveAttribute('aria-busy', 'false');
    if (original) {
      await expect(page.locator('#crop-clip-seek-feedback')).toHaveText(
        `원본을 찾지 못해 화면 녹화 중입니다 · ${format === 'webm' ? 'WebM' : 'MP4'}`,
      );
    }
    await page.waitForTimeout(duration);
    await expect(button).toHaveAttribute('data-recording', '');
    const capture = automatic || status ? await worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState) : undefined;
    const opened = context.waitForEvent('page');
    await page.keyboard.press('e');
    const result = await opened;
    if (automatic) {
      await expect.poll(() => result.isClosed(), { timeout: 35000 }).toBe(true);
      const download = await worker.evaluate(async previous =>
        (await chrome.downloads.search({ state: 'complete' })).find(item => !previous.includes(item.id)), previousDownloadIds);
      const filename = await worker.evaluate(async () => (await chrome.storage.local.get('testAutoDownloadFilename')).testAutoDownloadFilename);
      expect(filename).toMatch(new RegExp(`_\\d{8}_\\d{6}_\\d+s\\.${format}$`));
      expect(download?.filename.endsWith(`.${format}`)).toBe(true);
      const bytes = await fs.readFile(download.filename);
      const inspection = await context.newPage();
      try {
        await inspection.goto(`chrome-extension://${new URL(worker.url()).host}/popup/popup.html`);
        await verifyStartupDownload(inspection, bytes, format, capture);
      } finally {
        await inspection.close();
      }
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
      continue;
    }
    if (status) await expect(result.locator('#split-status')).toHaveText(status, { timeout: 35000 });
    if (original) await expect(result.locator('#format-chip')).toContainText('화면 녹화');
    else await expect(result.locator('#format-chip')).toContainText(format.toUpperCase());
    const video = result.locator('#preview-video');
    await expect.poll(() => video.evaluate(element => element.videoWidth)).toBeGreaterThan(0);
    if (status || format === 'mp4') expect(await result.evaluate(() => window.startupInspections)).toBe(status ? 1 : 0);
    const saved = await video.evaluate(element => element.duration);
    if (!status) {
      expect(saved).toBeGreaterThan(0.3);
      expect(saved).toBeLessThan(1.5);
    }
    const downloadPromise = result.waitForEvent('download');
    await result.locator('#download-current-button').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().endsWith(`_${Math.max(1, Math.round(saved))}s.${format}`)).toBe(true);
    if (status) await verifyStartupDownload(result, await fs.readFile(await download.path()), format, capture);
    await result.close();
  }
});
