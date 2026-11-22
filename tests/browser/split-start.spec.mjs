import { test, expect, interceptDownloads, decodeDownloads, expectResultResourcesReleased } from './fixtures.mjs';
import { mkdir, stat } from 'node:fs/promises';

function firstSyncSample(bytes) {
  const data = Buffer.from(bytes);
  const boxes = (start, end) => {
    const result = [];
    for (let offset = start; offset + 8 <= end;) {
      const size = data.readUInt32BE(offset);
      if (size < 8 || offset + size > end) throw Error('Invalid MP4 box');
      result.push({ type: data.toString('ascii', offset + 4, offset + 8), start: offset + 8, end: offset + size });
      offset += size;
    }
    return result;
  };
  const child = (box, type) => boxes(box.start, box.end).find(value => value.type === type);
  const moov = boxes(0, data.length).find(box => box.type === 'moov');
  if (!moov) throw Error('Missing MP4 metadata');
  for (const trak of boxes(moov.start, moov.end).filter(box => box.type === 'trak')) {
    const mdia = child(trak, 'mdia'), hdlr = child(mdia, 'hdlr');
    if (data.toString('ascii', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    const stbl = child(child(mdia, 'minf'), 'stbl');
    const stss = child(stbl, 'stss');
    return stss ? data.readUInt32BE(stss.start + 8) : 1;
  }
  throw Error('Missing video track');
}

async function prepareSplitSource(result, base, sizeMode = false, large = false) {
  await result.goto(base);
  const source = await result.evaluate(async ({ sizeMode, large }) => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const { putRecording, putPart } = await import('/shared/idb.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      // Sparse keyframes keep the tests sensitive to decoding dependencies.
      const code = await ffmpeg.exec([
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=9',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', sizeMode ? '60' : '120', '-keyint_min', sizeMode ? '60' : '120', '-sc_threshold', '0',
        ...(sizeMode ? ['-b:v', '2M', '-minrate', '2M', '-maxrate', '2M', '-bufsize', '2M', '-x264-params', 'nal-hrd=cbr'] : []),
        '-c:a', 'libopus', '-f', 'matroska', 'source.webm',
      ]);
      if (code !== 0) throw Error('Could not generate long-GOP source');
      let blob = await readFfmpegBlob(ffmpeg, 'source.webm', 'video/webm');
      if (large) {
        // Top-level EBML Void makes this a large WebM without changing its frames.
        const padding = new Uint8Array(64 * 1024 * 1024 + 5);
        padding.set([0xec, 0x14, 0x00, 0x00, 0x00]);
        blob = new Blob([blob, padding], { type: blob.type });
      }
      const id = crypto.randomUUID(), createdAt = Date.now();
      await putRecording({ id, createdAt, endedAt: createdAt + 9000, totalSize: blob.size, actualExtension: 'webm' });
      await putPart({ id: crypto.randomUUID(), recordingId: id, index: 0, filename: 'motion_20260717_120000_45s.webm',
        mimeType: 'video/webm', extension: 'webm', size: blob.size, blob, createdAt, seekMetadataVersion: large ? undefined : 1 });
      const hash = large ? undefined : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
      return { id, bytes: blob.size, hash };
    } finally { await releaseFfmpeg(); }
  }, { sizeMode, large });
  await result.goto(`${base}?id=${source.id}`);
  await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState >= 2 && video.duration > 8)).toBe(true);
  await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
  return source;
}

test('automatic splitting shares the result settings and downloads only the requested files', async ({ extension }, testInfo) => {
  test.setTimeout(180_000);
  const { context, worker, page } = extension;
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  const seed = await context.newPage();
  const { id, bytes } = await prepareSplitSource(seed, base, true);
  expect(bytes).toBeGreaterThan(1_000_000);
  await seed.close();
  const downloadPath = testInfo.outputPath('automatic-split');
  await mkdir(downloadPath, { recursive: true });
  const session = await context.newCDPSession(page);
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || location.pathname !== '/result/result.html') return;
    window.testAutomaticSplitFilenames = [];
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = async options => {
      const id = await download(options);
      window.testAutomaticSplitFilenames.push(options.filename);
      return id;
    };
    const params = new URLSearchParams(location.search);
    if (!params.has('autoSplit') || !params.has('autoDownload')) return;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'EXEC' && !window.resumeAutomaticSplit
        && document.getElementById('result-loading-message')?.textContent === '녹화 파일을 자동으로 나누는 중입니다.') {
        window.resumeAutomaticSplit = () => post.call(this, message, ...args);
        return;
      }
      return post.call(this, message, ...args);
    };
  });

  const cases = [
    { enabled: false, threshold: 1, mode: 'half', count: 0 },
    { enabled: true, threshold: 10, mode: 'half', count: 0, download: true },
    { enabled: true, threshold: 8, mode: 'half', count: 2 },
    { enabled: true, threshold: 8, mode: 'duration', count: 3 },
    { enabled: true, threshold: 8, mode: 'thirds', count: 3, download: true },
    { enabled: true, threshold: 8, mode: 'quarters', format: 'webm', count: 4, download: true },
    { enabled: true, threshold: 999, mode: 'size', maxMegabytes: 40, count: 0, download: true },
    { enabled: true, threshold: 999, mode: 'size', maxMegabytes: 1, download: true },
    { enabled: true, threshold: 8, mode: 'half', count: 2, download: true, autoFocus: false },
  ];
  const downloaded = () => worker.evaluate(async () => (await chrome.downloads.search({ state: 'complete' })).map(item => item.filename));
  for (const scenario of cases) {
    const { enabled, threshold, mode, download, format = 'mp4', maxMegabytes, autoFocus = true } = scenario;
    let { count } = scenario;
    const previousFiles = await downloaded();
    const opened = context.waitForEvent('page');
    await worker.evaluate(async options => {
      await chrome.storage.local.set({
        settings: {
          enableAutoSplitRecording: options.enabled, autoSplitAfterSeconds: options.threshold,
          autoSplitMode: options.mode, autoSplitIntervalSeconds: 4,
          autoSplitFormat: options.format, autoSplitMaxMegabytes: options.maxMegabytes,
          enableAutoDownloadRecording: Boolean(options.download), autoFocusResult: options.autoFocus,
        },
        recordingState: { status: 'completed', recordingId: options.id },
      });
      await chrome.alarms.create('open-recording-result', { when: Date.now() });
    }, { enabled, threshold, mode, download, id, format, maxMegabytes, autoFocus });
    const result = await opened;
    if (download && count !== 0) {
      await expect(result.locator('#result-loading-message')).toHaveText('녹화 파일을 자동으로 나누는 중입니다.');
      await expect.poll(() => result.evaluate(() => Boolean(window.resumeAutomaticSplit))).toBe(true);
      expect(await result.evaluate(async () => (await chrome.tabs.getCurrent())?.active)).toBe(autoFocus);
      if (autoFocus) await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
      await result.evaluate(() => window.resumeAutomaticSplit());
    }
    if (download && !autoFocus) {
      await expect.poll(() => result.isClosed()).toBe(true);
      expect(await downloaded()).toHaveLength(previousFiles.length + count);
      continue;
    }
    await expect(result.locator('#result-loading')).toBeHidden({ timeout: 60_000 });
    await expect(result.locator('#split-button')).toBeEnabled();
    await expect(result.getByRole('combobox', { name: '나누기 기준' })).toHaveValue(mode === 'size' ? 'size' : 'duration');
    await expect(result.getByRole('combobox', { name: '나누기 파일 형식' })).toHaveValue(format);
    const segments = result.locator('#split-files-list .split-chip-meta');
    if (count === undefined) {
      await expect.poll(() => segments.count()).toBeGreaterThan(1);
      count = await segments.count();
      await expect(result.getByRole('spinbutton', { name: '나누기 값' })).toHaveValue('1');
    }
    await expect(segments).toHaveCount(count);
    if (count) {
      await expect(result.locator('#split-status')).toHaveText(`자동 분할 완료 · ${count}개`);
      await expect(segments.first()).toHaveText(/^0:00 - 0:[\d.]+ · [\d.]+초 · /);
    }
    if (mode === 'duration') await expect(segments.last()).toHaveText(/^0:08 - 0:09(?:\.\d)? · 1\.0초 · /);
    const files = await downloaded();
    expect(files).toHaveLength(previousFiles.length + (download ? Math.max(1, count) : 0));
    if (maxMegabytes === 1) {
      for (const file of files.filter(path => !previousFiles.includes(path))) {
        expect((await stat(file)).size).toBeLessThanOrEqual(1_000_000);
      }
    }
    if (download) {
      const names = await result.evaluate(() => window.testAutomaticSplitFilenames);
      if (count) expect(names).toEqual(Array.from({ length: count }, (_, index) =>
        `motion_20260717_120000_${String(count - index).padStart(3, '0')}.${format}`));
      else expect(names).toEqual(['motion_20260717_120000_9s.webm']);
      expect(new URL(result.url()).searchParams.has('autoSplit')).toBe(false);
      await result.reload();
      await expect(result.locator('#split-button')).toBeEnabled();
      await expect(result.locator('#split-files-list .split-chip-meta')).toHaveCount(0);
      expect(await downloaded()).toEqual(files);
    }
    await result.close();
  }
});

test('screen recording fallback keeps its notice distinct from an automatic split timeout', async ({ extension }) => {
  const { context, worker } = extension;
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  const result = await context.newPage();
  const { id } = await prepareSplitSource(result, base);
  await result.evaluate(async id => {
    const { getPartsByRecordingId, putPart } = await import('/shared/idb.js');
    const [part] = await getPartsByRecordingId(id);
    await putPart({ ...part, captureMethod: 'screen' });
    await chrome.storage.local.set({ settings: { enableAutoSplitRecording: true, autoSplitAfterSeconds: 1 } });
  }, id);
  await context.addInitScript(() => {
    if (location.pathname !== '/result/result.html' || !location.search.includes('autoSplit=1')) return;
    window.extraVideoElements = 0;
    const create = document.createElement.bind(document);
    document.createElement = (tag, ...args) => {
      if (tag === 'video') window.extraVideoElements++;
      return create(tag, ...args);
    };
    const prototype = HTMLMediaElement.prototype;
    for (const [name, unready] of [['readyState', 0], ['duration', NaN]]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      Object.defineProperty(prototype, name, { ...descriptor, get() { return unready; } });
    }
    addEventListener('loadedmetadata', event => event.stopImmediatePropagation(), true);
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 15000 ? 800 : delay, ...args);
  });
  const pendingResult = await context.newPage();
  await pendingResult.goto(`${base}?id=${id}&autoSplit=1`);
  await expect(pendingResult.locator('#result-loading')).toBeHidden();
  await expect(pendingResult.locator('#empty-message')).toBeHidden();
  await expect(pendingResult.locator('#split-status')).toHaveText(/영상 길이를 확인하지 못해 자동 분할/);
  await expect(pendingResult.locator('#download-current-button')).toBeEnabled();
  expect(await pendingResult.evaluate(() => window.extraVideoElements)).toBe(0);
  await pendingResult.getByRole('button', { name: '화면 녹화 저장 안내' }).focus();
  await expect(pendingResult.locator('#capture-fallback-message')).toHaveText('방송 원본을 확보하지 못해 화면 녹화를 WebM으로 저장했습니다.');
  await expect(pendingResult.locator('#capture-fallback-message')).toHaveCSS('opacity', '1');
});

test('original MP4 playback cap preserves the start and media bytes', async ({ extension }) => {
  const { context, worker } = extension;
  const result = await context.newPage();
  await result.goto(`chrome-extension://${new URL(worker.url()).host}/result/result.html`);
  const measured = await result.evaluate(async () => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const { capMp4PlaybackDuration } = await import('/result/mp4_duration.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      const code = await ffmpeg.exec([
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=4',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-c:v', 'libx264', '-c:a', 'aac', '-use_editlist', '1', '-movflags', '+faststart', 'fixture.mp4',
      ]);
      if (code !== 0) throw Error('Could not generate MP4 fixture');
      const output = await ffmpeg.readFile('fixture.mp4', 'blob');
      if (!(output instanceof Blob)) throw Error('Media output must leave the worker as a Blob');
      const binary = await ffmpeg.readFile('fixture.mp4');
      const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
      const sameBytes = JSON.stringify(await digest(await output.arrayBuffer())) === JSON.stringify(await digest(binary));
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle('test-output.mp4', { create: true });
      const diskName = 'disk.mp4';
      if (!await ffmpeg.mount('CROPCLIP_OUTPUT', { file }, diskName)) throw Error('Could not mount temporary output');
      const remux = name => ffmpeg.exec(['-i', 'fixture.mp4', '-t', '2.37', '-map', '0', '-c', 'copy', '-use_editlist', '1', '-movflags', '+faststart', name]);
      let diskMatchesMemory;
      try {
        if (await remux(diskName) !== 0 || await remux('memory.mp4') !== 0) throw Error('MP4 remux failed');
        const disk = await ffmpeg.readFile(diskName, 'blob');
        const memory = await ffmpeg.readFile('memory.mp4', 'blob');
        diskMatchesMemory = JSON.stringify(await digest(await disk.arrayBuffer())) === JSON.stringify(await digest(await memory.arrayBuffer()));
      } finally {
        await ffmpeg.deleteFile(diskName);
        await root.removeEntry('test-output.mp4');
      }
      const source = await readFfmpegBlob(ffmpeg, 'fixture.mp4', 'video/mp4');
      const capped = await capMp4PlaybackDuration(source, 2.37);
      const read = async blob => {
        const video = document.createElement('video');
        const url = URL.createObjectURL(blob);
        try {
          await new Promise((resolve, reject) => {
            video.onloadeddata = resolve;
            video.onerror = () => reject(Error('Could not decode MP4'));
            video.src = url;
          });
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0);
          const frame = await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, canvas.width, canvas.height).data);
          return { duration: video.duration, frame: Array.from(new Uint8Array(frame)) };
        } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
      };
      const media = async blob => {
        const ftyp = new DataView(await blob.slice(0, 8).arrayBuffer()).getUint32(0);
        const moov = new DataView(await blob.slice(ftyp, ftyp + 8).arrayBuffer()).getUint32(0);
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.slice(ftyp + moov).arrayBuffer())));
      };
      const invalid = new Blob(['invalid']);
      return { sameBytes, diskMatchesMemory, original: await read(source), capped: await read(capped), media: await media(source),
        cappedMedia: await media(capped), invalidUnchanged: await capMp4PlaybackDuration(invalid, 2) === invalid };
    } finally { await releaseFfmpeg(); }
  });
  expect(measured.original.duration).toBeGreaterThan(3.9);
  expect(measured.sameBytes).toBe(true);
  expect(measured.diskMatchesMemory).toBe(true);
  expect(Math.abs(measured.capped.duration - 2.37)).toBeLessThan(0.1);
  expect(measured.capped.frame).toEqual(measured.original.frame);
  expect(measured.cappedMedia).toEqual(measured.media);
  expect(measured.invalidUnchanged).toBe(true);
});

test('large WebM seek metadata is prepared on disk and remains playable after cleanup', async ({ extension }) => {
  const { context, worker } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  await result.addInitScript(() => {
    window.diskMounts = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'MOUNT' && message.data.fsType === 'CROPCLIP_OUTPUT') window.diskMounts++;
      return post.call(this, message, ...args);
    };
  });
  const source = await prepareSplitSource(result, base, false, true);
  expect(await result.evaluate(() => window.diskMounts)).toBe(1);
  expect(result.workers()).toHaveLength(0);
  expect(await result.evaluate(async id => {
    const { getPartsByRecordingId } = await import('/shared/idb.js');
    const [part] = await getPartsByRecordingId(id);
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle(`cropclip-edit-${id}`);
    const hasWorkspace = !(await folder.keys().next()).done;
    return { version: part.seekMetadataVersion, hasWorkspace };
  }, source.id)).toEqual({ version: 1, hasWorkspace: false });
});

test('large original survives disk errors and a closed result without a RAM fallback', async ({ extension }) => {
  test.setTimeout(120_000);
  const { context, worker } = extension;
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  let result = await context.newPage();
  await result.goto(base);
  const source = await result.evaluate(async () => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const { putRecording, putPart } = await import('/shared/idb.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      const code = await ffmpeg.exec([
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=4',
        '-f', 'lavfi', '-i', 'sine=duration=4',
        '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+frag_keyframe+empty_moov', 'source.mp4',
      ]);
      if (code !== 0) throw Error('Could not generate original fixture');
      const video = await readFfmpegBlob(ffmpeg, 'source.mp4', 'video/mp4');
      const padding = new Uint8Array(64 * 1024 * 1024);
      new DataView(padding.buffer).setUint32(0, padding.length);
      padding.set([102, 114, 101, 101], 4); // MP4 free box
      const blob = new Blob([video, padding], { type: video.type });
      const id = crypto.randomUUID(), createdAt = Date.now();
      await putRecording({ id, createdAt, endedAt: createdAt + 3000, totalSize: blob.size, actualExtension: 'mp4' });
      await putPart({ id: 'test-original', recordingId: id, index: 1, filename: 'source.mp4',
        mimeType: blob.type, extension: 'mp4', blob, size: blob.size, createdAt,
        originalStreamStart: 0.25, originalStreamEnd: 3.25, captureMethod: 'original' });
      return { id, size: blob.size };
    } finally { await releaseFfmpeg(); }
  });
  const checkSource = async page => {
    expect(await page.evaluate(async id => {
      const { getPartsByRecordingId } = await import('/shared/idb.js');
      const [part] = await getPartsByRecordingId(id);
      return { size: part.blob.size, start: part.originalStreamStart };
    }, source.id)).toEqual({ size: source.size, start: 0.25 });
  };
  await context.addInitScript(() => {
    const mode = new URLSearchParams(location.search).get('fault');
    if (mode === 'storage') navigator.storage.getDirectory = async () => { throw new DOMException('Test disk full', 'QuotaExceededError'); };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (mode === 'mount' && message.type === 'MOUNT' && message.data.fsType === 'CROPCLIP_OUTPUT') {
        message = { ...message, data: { ...message.data, options: { file: null } } };
      }
      if (message.type === 'EXEC') {
        window.testExecCount = (window.testExecCount ?? 0) + 1;
        if (mode === 'close') return;
        if (mode === 'exec') message = { ...message, data: { ...message.data, args: ['-i', '/missing.mp4', 'output-original.mp4'] } };
      }
      if (message.type === 'READ_FILE' && message.data.path === 'output-original.mp4') {
        window.testFullOutputReads = (window.testFullOutputReads ?? 0) + 1;
      }
      return post.call(this, message, ...args);
    };
  });
  const url = `${base}?id=${source.id}`;
  for (const fault of ['storage', 'mount', 'exec', 'close']) {
    await result.goto(`${url}&fault=${fault}`);
    if (fault === 'close') {
      await expect.poll(() => result.evaluate(() => window.testExecCount ?? 0)).toBe(1);
      await result.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      await expect.poll(() => result.workers().length).toBe(0);
      await result.close();
      result = await context.newPage();
      await result.goto(base);
      await checkSource(result);
    } else {
      await expect(result.getByRole('button', { name: 'MP4 저장 다시 시도' })).toBeVisible({ timeout: 30000 });
      await expect(result.locator('#result-loading')).toBeHidden();
      await expect(result.locator('#download-current-button')).toBeDisabled();
      await checkSource(result);
      expect(result.workers()).toHaveLength(0);
      expect(await result.evaluate(() => window.testExecCount ?? 0)).toBe(fault === 'exec' ? 1 : 0);
      if (fault === 'storage') {
        const download = result.waitForEvent('download');
        await result.getByRole('button', { name: '방송 조각 백업 (.fmp4)' }).click();
        const backup = await download;
        expect(backup.suggestedFilename()).toBe('source.fmp4');
        expect((await stat(await backup.path())).size).toBe(source.size);
      }
    }
  }
  await result.goto(url);
  await expect(result.locator('#result-loading')).toBeHidden({ timeout: 30000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBeCloseTo(3, 1);
  expect(await result.evaluate(() => window.testFullOutputReads ?? 0)).toBe(0);
  await expect(result.locator('#trim-thumbnails .trim-thumbnail')).toHaveCount(0);
  await expect(result.locator('video[src]')).toHaveCount(1);
  const thumbnails = result.getByRole('button', { name: '장면 미리보기' });
  await thumbnails.click();
  await expect(result.locator('#trim-thumbnails .trim-thumbnail').first()).toBeAttached();
  await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
  await expect(result.locator('video[src]')).toHaveCount(1);
  expect(result.workers()).toHaveLength(0);
  expect(await result.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try { await root.getFileHandle('output-original.mp4'); return false; }
    catch (error) { return error.name === 'NotFoundError'; }
  })).toBe(true);
  await result.reload();
  await expect(thumbnails).toBeVisible();
  await result.evaluate(() => {
    document.addEventListener('loadedmetadata', event => {
      if (event.target instanceof HTMLVideoElement && event.target.id !== 'preview-video') {
        event.stopImmediatePropagation();
      }
    }, true);
  });
  await thumbnails.click();
  await expect(result.locator('video[src]')).toHaveCount(2);
  await result.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(result.locator('video[src]')).toHaveCount(0);
  await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
});

test('large normal MP4 edits download from disk without reading full outputs into the worker', async ({ extension }) => {
  test.setTimeout(120000);
  const { context, worker } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  await result.goto(base);
  const id = await result.evaluate(async () => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const { putRecording, putPart } = await import('/shared/idb.js');
    const ffmpeg = await loadFfmpeg(() => {});
    let blob;
    try {
      if (await ffmpeg.exec(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=4', '-c:v', 'libx264', '-g', '30', '-movflags', '+faststart', 'source.mp4']) !== 0) throw Error('Fixture encoding failed');
      const video = await readFfmpegBlob(ffmpeg, 'source.mp4', 'video/mp4');
      const padding = new Uint8Array(64 * 1024 * 1024);
      new DataView(padding.buffer).setUint32(0, padding.length);
      padding.set([102, 114, 101, 101], 4);
      blob = new Blob([video, padding], { type: video.type });
    } finally { await releaseFfmpeg(); }
    const id = crypto.randomUUID(), createdAt = Date.now();
    await putRecording({ id, createdAt, endedAt: createdAt + 4000, totalSize: blob.size, actualExtension: 'mp4' });
    await putPart({ id: `${id}:part:001`, recordingId: id, index: 1, filename: 'large.mp4', mimeType: blob.type, extension: 'mp4', blob, size: blob.size, createdAt });
    return id;
  });
  await result.goto(`${base}?id=${id}`);
  await expect(result.locator('#split-button')).toBeEnabled();
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBe(4);
  await result.evaluate(() => {
    window.splitDiskAudit = { mounts: 0, reads: 0 };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'MOUNT' && message.data.fsType === 'CROPCLIP_OUTPUT') window.splitDiskAudit.mounts++;
      if (message.type === 'READ_FILE') window.splitDiskAudit.reads++;
      return post.call(this, message, ...args);
    };
  });
  await result.locator('[data-split-count="2"]').click();
  await result.locator('#split-button').click();
  await expect(result.locator('#split-result-summary')).toHaveText('나눈 파일 (2개)');
  expect(await result.evaluate(() => window.splitDiskAudit)).toEqual({ mounts: 2, reads: 0 });
  await expect(result.locator('#split-button')).toBeEnabled();
  const jobCount = () => worker.evaluate(async id => {
    const root = await navigator.storage.getDirectory();
    try {
      const dir = await root.getDirectoryHandle(`cropclip-edit-${id}`);
      let count = 0;
      for await (const _ of dir.keys()) count++;
      return count;
    } catch (error) {
      if (error.name === 'NotFoundError') return -1;
      throw error;
    }
  }, id);
  expect(await jobCount()).toBe(1);
  const download = result.waitForEvent('download');
  await result.getByRole('button', { name: '1번 파일 다운로드' }).click();
  const first = await download;
  expect(await first.failure()).toBeNull();
  expect((await stat(await first.path())).size).toBeGreaterThan(0);
  await result.locator('#split-format-select').selectOption('webm');
  await result.locator('#split-button').click();
  await expect(result.locator('#split-result-summary')).toHaveText('나눈 파일 (2개)');
  await expect(result.locator('#split-button')).toBeEnabled();
  expect(await result.evaluate(() => window.splitDiskAudit)).toEqual({ mounts: 4, reads: 1 });
  await interceptDownloads(result);
  for (const button of await result.locator('#split-files-list button').all()) await button.click();
  expect(await decodeDownloads(result)).toEqual([true, true]);
  await result.locator('#split-format-select').selectOption('mp4');
  await result.locator('#trim-start-input').fill('0.3');
  await result.locator('#trim-start-input').press('Tab');
  await expect.poll(jobCount).toBe(0);
  await result.locator('[data-split-count="2"]').click();
  await result.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'MOUNT' && message.data.fsType === 'CROPCLIP_OUTPUT') {
        Worker.prototype.postMessage = post;
        message = { ...message, data: { ...message.data, options: { file: null } } };
      }
      return post.call(this, message, ...args);
    };
  });
  const failure = result.waitForEvent('dialog');
  const started = result.locator('#split-button').click();
  const dialog = await failure;
  await dialog.dismiss();
  await started;
  await expect(result.locator('#split-button')).toBeEnabled();
  await expect.poll(jobCount).toBe(0);
  expect(await result.evaluate(() => window.splitDiskAudit.reads)).toBe(1);
  await result.locator('#split-button').click();
  await expect(result.locator('#split-result-summary')).toHaveText('나눈 파일 (2개)');
  await expect(result.locator('#split-button')).toBeEnabled();
  await result.evaluate(() => {
    window.testDownloads = [];
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = async options => {
      window.testDownloads.push(await (await fetch(options.url)).blob());
      return download(options);
    };
  });
  await result.locator('#speed-select').selectOption('2');
  await result.locator('#speed-convert-button').click();
  await expect(result.locator('#split-status')).toHaveText('2배속 MP4 다운로드가 준비되었습니다.');
  expect(await decodeDownloads(result, 2.5)).toEqual([true]);
  await expect.poll(jobCount).toBe(1);
  expect(await result.evaluate(() => window.splitDiskAudit.reads)).toBe(1);
  await result.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.type === 'EXEC') {
        Worker.prototype.postMessage = post;
        message = { ...message, data: { ...message.data, args: ['-i', '/missing.mp4', 'output.mp4'] } };
      }
      return post.call(this, message, ...args);
    };
  });
  await result.locator('#download-current-button').click();
  await expect(result.locator('#split-status')).toHaveText('선택 구간 다운로드가 준비되었습니다.');
  expect(await decodeDownloads(result, 4)).toEqual([true]);
  await expect.poll(jobCount).toBe(1);
  expect(await result.evaluate(() => window.splitDiskAudit.reads)).toBe(1);
  await result.evaluate(async id => {
    const { getPartsByRecordingId, putPart } = await import('/shared/idb.js');
    const [source] = await getPartsByRecordingId(id);
    const padding = new Uint8Array(64 * 1024 * 1024);
    new DataView(padding.buffer).setUint32(0, padding.length);
    padding.set([102, 114, 101, 101], 4);
    const blob = new Blob([source.blob, padding], { type: source.mimeType });
    await putPart({ ...source, blob, size: blob.size, startupTrimSeconds: 1.6 });
  }, id);
  await result.reload();
  await expect(result.locator('#split-status')).toHaveText('녹화 초반의 끊긴 구간을 제외했습니다.');
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBeCloseTo(2, 1);
  await expect.poll(jobCount).toBe(1);
  await result.close();
  await worker.evaluate(async id => {
    const key = `delete-recording:${id}`;
    await chrome.storage.local.set({ [key]: Date.now() - 1 });
    await chrome.alarms.create(key, { when: Date.now() });
  }, id);
  await expect.poll(jobCount).toBe(-1);
});

test('WebM to MP4 splits start with independently decodable video', async ({ extension }) => {
  test.setTimeout(150_000);
  const { context, worker } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  await prepareSplitSource(result, base);
  const retained = await result.evaluate(() => window.testObjectUrls.size);
  await interceptDownloads(result);
  await result.evaluate(() => {
    window.testSplitCommands = [];
    window.testSplitVideos = 0;
    const create = document.createElement.bind(document);
    document.createElement = (...args) => {
      if (args[0] === 'video') window.testSplitVideos++;
      return create(...args);
    };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'EXEC') window.testSplitCommands.push(message.data.args);
      return post.call(this, message, ...args);
    };
  });
  const sourceDuration = await result.locator('#preview-video').evaluate(video => video.duration);
  for (const trimmed of [false, true]) {
    if (trimmed) {
      await result.locator('#trim-start-input').fill('1.3');
      await result.locator('#trim-start-input').press('Tab');
      await result.locator('#trim-end-input').fill('7.3');
      await result.locator('#trim-end-input').press('Tab');
    }
    for (const count of [3, 4, 2]) {
      await result.locator('#split-format-select').selectOption('mp4');
      await result.locator(`[data-split-count="${count}"]`).click();
      if (!trimmed && count === 3) await result.locator('#split-value-input').fill('3');
      const seconds = Number(await result.locator('#split-value-input').inputValue());
      await result.evaluate(() => { window.testSplitVideos = 0; });
      await result.locator('#split-button').click();
      await expect(result.locator('#split-result-summary')).toHaveText(`나눈 파일 (${count}개)`, { timeout: 30000 });
      await expect(result.locator('#split-button')).toBeEnabled();
      expect(await result.evaluate(() => window.testSplitVideos)).toBe(0);
      const commands = await result.evaluate(() => window.testSplitCommands.splice(0));
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every(args => args[args.indexOf('-c') + 1] === 'copy'), 'fast splitting must not re-encode the video').toBe(true);
      for (const button of await result.locator('#split-files-list button').all()) await button.click();
      const files = await result.evaluate(async () => Promise.all((await Promise.all(window.testDownloads.splice(0)))
        .map(async blob => Array.from(new Uint8Array(await blob.arrayBuffer())))));
      expect(files).toHaveLength(count);
      const firstSync = files.map(firstSyncSample);
      console.log(JSON.stringify({ count, trimmed, firstSync }));
      expect(firstSync, 'every MP4 must retain the keyframe needed to decode its first video sample').toEqual(Array(count).fill(1));
      for (const [index, bytes] of files.entries()) {
        const start = await result.evaluate(async bytes => {
          const video = document.createElement('video');
          video.muted = true;
          video.preload = 'auto';
          video.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;z-index:2147483647';
          document.body.append(video);
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
          let timeout;
          try {
            const times = [];
            await new Promise((resolve, reject) => {
              timeout = setTimeout(() => reject(Error('Split video did not advance')), 8000);
              let playing = false;
              const tick = (_now, metadata) => {
                times.push(metadata.mediaTime);
                // Sample the paused first frame before the playback clock can skip ahead.
                if (!playing) { playing = true; video.play().catch(reject); }
                if (metadata.mediaTime >= 0.6) resolve();
                else video.requestVideoFrameCallback(tick);
              };
              video.requestVideoFrameCallback(tick);
              video.onerror = () => reject(Error('Split video failed to decode'));
              video.src = url;
            });
            return { firstTime: times[0], earlyFrames: times.filter(time => time < 0.5).length, duration: video.duration };
          } finally {
            clearTimeout(timeout);
            video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
          }
        }, bytes);
        expect(start.firstTime, `file ${index + 1} must display video from its start`).toBeLessThan(0.1);
        expect(start.earlyFrames, 'video must advance during the first half-second').toBeGreaterThan(2);
        const expectedDuration = Math.min(seconds, (trimmed ? 6 : sourceDuration) - index * seconds);
        expect(Math.abs(start.duration - expectedDuration), 'decoding preroll must not extend visible playback').toBeLessThan(0.15);
      }
      await expectResultResourcesReleased(result, retained);
    }
  }
});

test('WebM splits begin with playable video even between source keyframes', async ({ extension }) => {
  const { context, worker } = extension;
  const result = await context.newPage();
  await prepareSplitSource(result, `chrome-extension://${new URL(worker.url()).host}/result/result.html`);
  await interceptDownloads(result);
  await result.locator('#split-format-select').selectOption('webm');
  await result.locator('#split-value-input').fill('3.1');
  await result.locator('#split-button').click();
  await expect(result.locator('#split-result-summary')).toHaveText('나눈 파일 (3개)', { timeout: 30000 });
  for (const button of await result.locator('#split-files-list button').all()) await button.click();
  const firstFrames = await result.evaluate(async () => Promise.all((await Promise.all(window.testDownloads)).map(async blob => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No first frame')), 5000);
        video.requestVideoFrameCallback((_now, frame) => { clearTimeout(timeout); resolve(frame.mediaTime); });
        video.src = url;
        document.body.append(video);
      });
    } finally {
      video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
    }
  })));
  expect(firstFrames).toHaveLength(3);
  for (const time of firstFrames) expect(time).toBeLessThan(0.1);
});

test('size split retries reuse one prepared source and recover from failure', async ({ extension }) => {
  test.setTimeout(150000);
  const { context, worker } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  const source = await prepareSplitSource(result, base, true);
  expect(source.bytes).toBeGreaterThan(2000000);
  const retained = await result.evaluate(() => window.testObjectUrls.size);
  const dialogs = [];
  result.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await interceptDownloads(result);
  await result.evaluate(() => {
    const audit = window.testSizeAudit = { inputs: 0, inputBytes: 0, executions: 0, videos: 0, failNext: false };
    const create = document.createElement.bind(document);
    document.createElement = (...args) => { if (args[0] === 'video') audit.videos++; return create(...args); };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'MOUNT' && message.data.mountPoint === '/source') {
        audit.inputs++; audit.inputBytes += message.data.options.blobs[0].data.size;
      }
      if (message?.type === 'EXEC') {
        audit.executions++;
        if (audit.failNext) {
          audit.failNext = false;
          message = { ...message, data: { ...message.data, args: ['-i', '/source/input.webm', '-c:v', 'cropclip-invalid-codec', 'output-invalid.mp4'] } };
        }
      }
      return post.call(this, message, ...args);
    };
  });
  await result.locator('#split-format-select').selectOption('mp4');
  await result.locator('#split-mode-select').selectOption('size');
  await result.locator('#split-value-input').fill('1');
  await result.locator('#split-button').click();
  await expect(result.locator('#split-result-summary')).toHaveText(/나눈 파일 \([2-9]\d*개\)/, { timeout: 60000 });
  await expect(result.locator('#split-button')).toBeEnabled();
  const audit = await result.evaluate(() => window.testSizeAudit);
  for (const button of await result.locator('#split-files-list button').all()) await button.click();
  const sizes = await result.evaluate(async () => (await Promise.all(window.testDownloads)).map(blob => blob.size));
  expect(audit.executions).toBeGreaterThan(sizes.length); // The workload must actually exercise the size retry.
  expect(audit.inputs, 'all size attempts must share the prepared input').toBe(1);
  expect(audit.inputBytes).toBe(source.bytes);
  expect(audit.videos, 'reuse the loaded preview metadata across size attempts').toBe(0);
  expect(sizes.every(bytes => bytes > 0 && bytes <= 1000000)).toBe(true);
  expect(await decodeDownloads(result)).toEqual(Array(sizes.length).fill(true));
  await expectResultResourcesReleased(result, retained);

  await result.evaluate(() => { window.testSizeAudit.failNext = true; });
  await result.locator('#split-button').click();
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(result.locator('#split-button')).toBeEnabled();
  await expectResultResourcesReleased(result, retained);
  await result.locator('#split-button').click();
  await expect(result.locator('#split-result-summary')).toHaveText(/나눈 파일 \([2-9]\d*개\)/, { timeout: 60000 });
  await expect(result.locator('#split-button')).toBeEnabled();
  expect(await result.evaluate(() => window.testSizeAudit.inputs)).toBe(3);
  await expectResultResourcesReleased(result, retained);
  const hash = await result.evaluate(async id => {
    const { getPartsByRecordingId } = await import('/shared/idb.js');
    const [part] = await getPartsByRecordingId(id);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await part.blob.arrayBuffer()))).join(',');
  }, source.id);
  expect(hash).toBe(source.hash);
  expect(dialogs).toHaveLength(1);
});

test('split downloads finish in reverse order for newest-first folder sorting', async ({ extension }, testInfo) => {
  test.setTimeout(90000);
  const { context, worker } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  await prepareSplitSource(result, base);
  const session = await context.newCDPSession(result);
  const dialogs = [];
  result.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await result.evaluate(() => {
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = async options => {
      const id = await download(options);
      window.testSavedFiles.push({ id, filename: options.filename });
      return id;
    };
  });
  for (const automatic of [false, true]) {
    if (automatic) {
      await worker.evaluate(() => chrome.storage.local.set({ settings: { enableAutoDownloadSplit: true } }));
      await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30000 });
    }
    await expect(result.locator('#trim-thumbnails .trim-thumbnail').first()).toBeAttached();
    await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
    const retained = await result.evaluate(() => window.testObjectUrls.size);
    const downloadPath = testInfo.outputPath(automatic ? 'automatic' : 'manual');
    await mkdir(downloadPath, { recursive: true });
    await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
    await result.evaluate(() => { window.testSavedFiles = []; });
    await result.locator('#split-format-select').selectOption('mp4');
    await result.locator('[data-split-count="4"]').click();
    await result.locator('#split-button').click();
    await expect(result.locator('#split-result-summary')).toHaveText('나눈 파일 (4개)', { timeout: 30000 });
    if (!automatic) {
      await expect(result.locator('#download-all-button')).toBeEnabled();
      await result.locator('#download-all-button').evaluate(button => { button.click(); button.click(); });
    }
    await expect.poll(() => result.evaluate(() => window.testSavedFiles.length)).toBe(4);
    await expect(result.locator('#download-all-button')).toBeEnabled();
    const files = await result.evaluate(async () => Promise.all(window.testSavedFiles.map(async ({ id, filename }) => {
      const [item] = await chrome.downloads.search({ id });
      return { requestedName: filename, path: item.filename, state: item.state };
    })));
    expect(files.map(file => file.requestedName)).toEqual([4, 3, 2, 1].map(index => `motion_20260717_120000_00${index}.mp4`));
    expect(files.map(file => file.state)).toEqual(Array(4).fill('complete'));
    const saved = await Promise.all(files.map(file => stat(file.path)));
    expect(saved.every(file => file.size > 0)).toBe(true);
    for (let index = 1; index < saved.length; index++) {
      expect(saved[index].mtimeMs).toBeGreaterThan(saved[index - 1].mtimeMs);
    }
    await expectResultResourcesReleased(result, retained);
    expect(dialogs).toEqual([]);
  }
});
