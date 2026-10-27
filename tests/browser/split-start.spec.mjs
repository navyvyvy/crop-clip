import { test, expect, interceptDownloads, decodeDownloads, expectResultResourcesReleased } from './fixtures.mjs';

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

async function prepareSplitSource(result, base, sizeMode = false) {
  await result.goto(base);
  const source = await result.evaluate(async sizeMode => {
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
      const blob = await readFfmpegBlob(ffmpeg, 'source.webm', 'video/webm');
      const id = crypto.randomUUID(), createdAt = Date.now();
      await putRecording({ id, createdAt, endedAt: createdAt + 9000, totalSize: blob.size, actualExtension: 'webm' });
      await putPart({ id: crypto.randomUUID(), recordingId: id, index: 0, filename: 'motion.webm',
        mimeType: 'video/webm', extension: 'webm', size: blob.size, blob, createdAt, seekMetadataVersion: 1 });
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))).join(',');
      return { id, bytes: blob.size, hash };
    } finally { await releaseFfmpeg(); }
  }, sizeMode);
  await result.goto(`${base}?id=${source.id}`);
  await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState >= 2 && video.duration > 8)).toBe(true);
  await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
  return source;
}

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
      await result.locator(count === 2 ? '[data-split-ratio="0.5"]' : `[data-split-count="${count}"]`).click();
      if (!trimmed && count === 3) await result.locator('#split-value-input').fill('3');
      const seconds = Number(await result.locator('#split-value-input').inputValue());
      await result.locator('#split-button').click();
      await expect(result.locator('#split-result-summary')).toHaveText(`나눈 파일 (${count}개)`, { timeout: 30000 });
      await expect(result.locator('#split-button')).toBeEnabled();
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
      if (message?.type === 'WRITE_FILE' && message.data.path === 'input.webm') {
        audit.inputs++; audit.inputBytes += message.data.data.byteLength;
      }
      if (message?.type === 'EXEC') {
        audit.executions++;
        if (audit.failNext) {
          audit.failNext = false;
          message = { ...message, data: { ...message.data, args: ['-i', 'input.webm', '-c:v', 'cropclip-invalid-codec', 'output-invalid.mp4'] } };
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
  expect(audit.videos, 'source metadata must be loaded only once').toBe(1);
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
