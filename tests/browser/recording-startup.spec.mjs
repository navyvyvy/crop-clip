import { test, expect, prepareVideo, decodeDownloads, interceptDownloads } from './fixtures.mjs';
import fs from 'node:fs/promises';

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

async function observeRecordingStartup(worker) {
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const timing = globalThis.cropClipStartupTiming = { probes: [], starts: [] };
      const probe = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = async config => {
        if (!config.codec.startsWith('avc1')) return probe(config);
        const sample = { began: performance.now(), finished: null };
        timing.probes.push(sample);
        try { return await probe(config); }
        finally { sample.finished = performance.now(); }
      };
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...args) {
        const sample = { began: performance.now(), firstChunk: null, mimeType: this.mimeType };
        timing.starts.push(sample);
        this.addEventListener('dataavailable', event => {
          if (sample.firstChunk === null && event.data.size > 0) sample.firstChunk = performance.now();
        });
        start.apply(this, args);
      };
    } });
  });
}

async function readRecordingStartup(worker) {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://chzzk.naver.com/extension-test' });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: () => globalThis.cropClipStartupTiming,
    });
    return result;
  });
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
  const generator = await context.newPage();
  await generator.goto(`chrome-extension://${new URL(worker.url()).host}/result/result.html`);
  const source = await generator.evaluate(async () => {
    const { loadFfmpeg, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      const code = await ffmpeg.exec(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '45',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', 'source.mp4']);
      if (code !== 0) throw new Error('Continuity fixture encoding failed');
      const bytes = await ffmpeg.readFile('source.mp4');
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return btoa(binary);
    } finally { await releaseFfmpeg(); }
  });
  await generator.close();
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.locator('video').evaluate(async (video, base64) => {
    const bytes = Uint8Array.from(atob(base64), byte => byte.charCodeAt(0));
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    window.testSourceGaps = [];
    let previous;
    const observe = (now, { presentedFrames, mediaTime }) => {
      if (previous !== undefined && now - previous >= 80) window.testSourceGaps.push({ now, gap: now - previous, mediaTime });
      previous = now;
      window.testSourceFrames = presentedFrames;
      video.requestVideoFrameCallback(observe);
    };
    video.requestVideoFrameCallback(observe);
    await video.play();
  }, source);
  await worker.evaluate(async outputFormat => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, outputFormat, videoBitsPerSecond: 16_000_000 } });
  }, format);
  await worker.evaluate(async () => {
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
  await page.keyboard.press('e');
  await expect(page.locator('#crop-clip-chzzk-record-button')).toHaveAttribute('data-recording', '');
  if (format === 'mp4' && process.env.CROPCLIP_TEST_WITHOUT_AAC) {
    await expect(page.locator('html')).toHaveAttribute('data-test-recorder-mime', /avc1,opus/);
  }
  const playbackClock = () => page.locator('video').evaluate(video => ({
    time: video.currentTime, wall: performance.now() / 1000, frames: window.testSourceFrames ?? 0,
  }));
  const start = await playbackClock();
  await page.waitForTimeout(33_000);
  const end = await playbackClock();
  const playedSeconds = end.time - start.time;
  expect(Math.abs(playedSeconds - (end.wall - start.wall))).toBeLessThan(0.5);
  const sourceGaps = await page.evaluate(({ start, end }) => window.testSourceGaps.filter(({ now }) => now >= start && now <= end),
    { start: start.wall * 1000, end: end.wall * 1000 });
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30000 });
  const downloaded = result.waitForEvent('download');
  await result.locator('#download-current-button').click();
  const bytes = await fs.readFile(await (await downloaded).path());
  const { video, audio, decodeResult, freezeReport } = await result.evaluate(async ({ base64, format }) => {
    const { loadFfmpeg, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const bytes = Uint8Array.from(atob(base64), byte => byte.charCodeAt(0));
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      const filename = `recording.${format}`;
      await ffmpeg.writeFile(filename, bytes);
      await ffmpeg.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries',
        'packet=pts_time', '-of', 'json', '-o', 'packets.json', filename], 4000);
      const { packets } = JSON.parse(await ffmpeg.readFile('packets.json', 'utf8'));
      const video = packets.map(packet => Number(packet.pts_time)).sort((a, b) => a - b);
      const audio = [];
      ffmpeg.on('log', ({ message }) => {
        const frame = /\bpts_time:([\d.eE+-]+).*\brate:(\d+)\s+nb_samples:(\d+)/.exec(message);
        if (!frame) return;
        const start = Number(frame[1]);
        audio.push({ start, end: start + Number(frame[3]) / Number(frame[2]) });
      });
      const decodeResult = await ffmpeg.exec(['-v', 'info', '-xerror', '-copyts', '-i', filename, '-map', '0:v:0', '-map', '0:a:0',
        '-af', 'ashowinfo',
        '-vf', 'freezedetect=n=-60dB:d=0.18,metadata=mode=print:key=lavfi.freezedetect.freeze_start:file=freezes.txt',
        '-f', 'null', '-'], 10_000);
      const freezeReport = decodeResult === 0 ? await ffmpeg.readFile('freezes.txt', 'utf8') : '';
      return { video, audio, decodeResult, freezeReport };
    } finally { await releaseFfmpeg(); }
  }, { base64: bytes.toString('base64'), format });
  const videoSeconds = video.at(-1) - video[0];
  const audioSeconds = audio.at(-1).end - audio[0].start;
  const videoMaxGap = Math.max(...video.slice(1).map((time, index) => time - video[index]));
  const audioMaxGap = Math.max(0, ...audio.slice(1).map((frame, index) => frame.start - audio[index].end));
  await testInfo.attach('download-timing.json', {
    body: JSON.stringify({
      playedSeconds, sourceFrames: end.frames - start.frames, videoSeconds, audioSeconds, videoMaxGap, audioMaxGap,
      videoFrames: video.length, freezeReport, sourceGaps,
    }, null, 2),
    contentType: 'application/json',
  });
  expect(decodeResult, 'the downloaded video and audio must decode to the end').toBe(0);
  expect(freezeReport, 'the moving picture must not freeze, even if packets keep arriving').toBe('');
  expect(Math.abs(videoSeconds - playedSeconds), 'the downloaded video must keep the source playback speed').toBeLessThan(1);
  expect(Math.abs(video[0] - audio[0].start), 'picture and sound must start together').toBeLessThan(0.15);
  expect(Math.abs(video.at(-1) - audio.at(-1).end), 'picture and sound must end together').toBeLessThan(0.25);
  expect(video.length / videoSeconds, 'the 30fps source must retain its frame rate').toBeGreaterThan(25);
  expect(videoMaxGap, 'the downloaded picture must stay continuous from start to end').toBeLessThan(0.12);
  expect(audioMaxGap, 'the downloaded sound must stay continuous from start to end').toBeLessThan(0.08);
});

test('MP4 recording uses H.265 only for a confirmed H.265 source', async ({ extension }) => {
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

const startupTimingTest = process.env.CROPCLIP_STARTUP_REPORT ? test : test.skip;
startupTimingTest('first recording frame timing', async ({ extension }) => {
  test.setTimeout(90_000);
  const { worker, page } = extension;
  const regionMode = process.env.CROPCLIP_STARTUP_MODE === 'region';
  if (regionMode) await worker.evaluate(() => {
    const region = { x: 400, y: 200, width: 400, height: 200, videoRelative: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };
    return chrome.storage.local.set({ region, regions: [region] });
  });
  const button = page.locator(regionMode ? '.crop-clip-border .record-region' : '#crop-clip-chzzk-record-button');
  // Generate this source with recording-profile.spec.mjs first; encoding it in this
  // browser would warm the encoder and invalidate the first-start measurement.
  const source = await fs.readFile(process.env.CROPCLIP_STARTUP_SOURCE || 'node_modules/.cache/cropclip-profile-source.webm');
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
  await page.getByRole('button', { name: 'Native', exact: true }).click();
  await page.evaluate(async encoded => {
    const video = document.querySelector('video');
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    video.loop = true;
    await video.play();
    const frames = window.__startupFrames = [];
    const tick = now => { frames.push(now); video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  }, source.toString('base64'));
  const samples = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    // Give the cold capability check time to finish during ordinary viewing.
    await page.waitForTimeout(cycle === 0 ? 8000 : 1500);
    const start = await page.evaluate(() => performance.now());
    await page.keyboard.press(regionMode ? 'r' : 'e');
    await expect(button).toHaveAttribute('aria-busy', 'false', { timeout: 20_000 });
    await expect(button).toHaveAttribute('data-recording', '');
    await page.waitForTimeout(2000); // Include encoder startup and the first checkpoint.
    const timing = await readRecordingStartup(worker);
    const recording = timing.starts[cycle];
    const startup = await page.evaluate(start => {
      const frames = window.__startupFrames;
      const gaps = frames.slice(1).map((time, index) => ({ time, gap: time - frames[index] }));
      const baseline = gaps.filter(frame => frame.time >= start - 1000 && frame.time < start);
      const startup = gaps.filter(frame => frame.time >= start);
      const worst = startup.reduce((longest, frame) => frame.gap > longest.gap ? frame : longest, { gap: 0, time: start });
      return { baselineMaxGap: Math.max(...baseline.map(frame => frame.gap)),
        startupMaxGap: Math.max(...startup.map(frame => frame.gap)), startupMaxGapAt: worst.time - start };
    }, start);
    samples.push({
      cycle, ...startup, mimeType: recording.mimeType,
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
  await fs.writeFile(process.env.CROPCLIP_STARTUP_REPORT, JSON.stringify({ mode: regionMode ? 'region' : 'full', captureMode, samples }, null, 2));
  console.log(JSON.stringify(samples));
  // Keep the actual failure visible when explicitly running this diagnostic.
  for (const sample of samples) {
    expect(Number.isFinite(sample.baselineMaxGap) && Number.isFinite(sample.startupMaxGap), 'both intervals must contain video frames').toBe(true);
    expect(sample.clickToFirstChunk, 'timing must include a recording that actually produced data').toEqual(expect.any(Number));
  }
  expect(samples[0].startupMaxGap, 'the first recording must not stall playback for 200ms').toBeLessThan(200);
});

for (const format of ['webm', 'mp4']) test(`${format} download inspects opening timestamps even without a capture stall marker`, async ({ extension }) => {
  const { worker, context } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  await result.goto(base);
  const id = await result.evaluate(async format => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const { putRecording, putPart } = await import('/shared/idb.js');
    const ffmpeg = await loadFfmpeg(() => {});
    const filename = `startup.${format}`;
    const openingDuration = format === 'webm' ? 0.16 : 1;
    let blob;
    try {
      const code = await ffmpeg.exec([
        '-f', 'lavfi', '-i', `color=red:size=160x90:rate=30:duration=${openingDuration}`,
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=1.3',
        '-filter_complex', `[0:v][1:v]concat=n=2:v=1:a=0[joined];[joined]select='${format === 'webm'
          ? 'not(between(n,1,2)+eq(n,4))' : 'if(lt(t,1),not(mod(n,3)),1)'}'[v]`, '-map', '[v]', '-fps_mode', 'vfr',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '240', '-sc_threshold', '0',
        '-f', format === 'webm' ? 'matroska' : 'mp4', filename,
      ]);
      if (code !== 0) throw Error('Startup fixture encoding failed');
      blob = await readFfmpegBlob(ffmpeg, filename, `video/${format}`);
    } finally { await releaseFfmpeg(); }
    const id = crypto.randomUUID(), createdAt = Date.now();
    await putRecording({ id, createdAt, endedAt: createdAt + openingDuration * 1000 + 1300, totalSize: blob.size, actualExtension: format });
    await putPart({ id: `${id}:part:001`, recordingId: id, index: 1, filename, extension: format,
      mimeType: blob.type, size: blob.size, blob, createdAt, videoBitsPerSecond: 8_500_000, inspectStartup: true, seekMetadataVersion: 1 });
    return id;
  }, format);
  if (format === 'webm') {
    await context.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args) {
        const ffmpegArgs = message?.data?.args;
        if (message?.type === 'EXEC' && ffmpegArgs?.at(-1) === 'output-startup-trimmed.webm') {
          const bitrate = ffmpegArgs.indexOf('-b:v');
          window.testStartupTrimBitrate = bitrate >= 0 ? ffmpegArgs[bitrate + 1] : '';
        }
        return post.call(this, message, ...args);
      };
    });
  }
  await result.goto(`${base}?id=${id}`);
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30000 });
  if (format === 'webm') expect(await result.evaluate(() => window.testStartupTrimBitrate)).toBe('8500000');
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
      const first = frame();
      const seeked = new Promise(resolve => { video.onseeked = resolve; });
      video.currentTime = 0.35;
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
  expect(frames.openingRedShare).toBeLessThan(0.9);
  expect(frames.changedShare).toBeGreaterThan(0.025);
  expect(frames.duration).toBeGreaterThan(0.9);
  expect(frames.duration).toBeLessThan(1.5);
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

for (const format of ['webm', 'mp4']) test(`full H.264 ${format} recordings exclude a stalled opening and keep short originals`, async ({ extension }, testInfo) => {
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
      if (message.type === 'FFPROBE') window.startupInspections++;
      return post.call(this, message, ...args);
    };
  });
  const cases = [
    { duration: 5000, status: /끊긴 구간을 제외/, min: 2, max: 4.85 },
    { duration: 450, min: 0.3, max: 1.5 },
  ];
  cases.push({ duration: 5000, automatic: true });
  for (const { duration, status, min, max, automatic } of cases) {
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
    await expect(page.locator('#crop-clip-seek-feedback')).toHaveText(
      `화면 녹화 중 · ${format === 'webm' ? 'WebM' : 'MP4'} 지원하는 라이브 재생이 아닙니다.`,
    );
    await page.waitForTimeout(duration);
    await expect(button).toHaveAttribute('data-recording', '');
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
      await page.evaluate(({ data, format }) => {
        window.testDownloads = [new Blob([Uint8Array.from(atob(data), byte => byte.charCodeAt(0))], { type: `video/${format}` })];
      }, { data: bytes.toString('base64'), format });
      expect(await decodeDownloads(page, 4.85)).toEqual([true]);
      await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('idle');
      continue;
    }
    if (status) await expect(result.locator('#split-status')).toHaveText(status, { timeout: 35000 });
    await expect(result.locator('#format-chip')).toContainText('화면 녹화');
    const video = result.locator('#preview-video');
    await expect.poll(() => video.evaluate(element => element.videoWidth)).toBeGreaterThan(0);
    expect(await result.evaluate(() => window.startupInspections)).toBe(status ? 1 : 0);
    const saved = await video.evaluate(element => element.duration);
    expect(saved).toBeGreaterThan(min);
    expect(saved).toBeLessThan(max);
    const downloadPromise = result.waitForEvent('download');
    await result.locator('#download-current-button').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().endsWith(`_${Math.max(1, Math.round(saved))}s.${format}`)).toBe(true);
    await result.close();
  }
});
