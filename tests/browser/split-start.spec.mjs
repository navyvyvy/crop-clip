import { test, expect, interceptDownloads, expectResultResourcesReleased } from './fixtures.mjs';

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

test('WebM to MP4 splits start with independently decodable video', async ({ extension }) => {
  test.setTimeout(150_000);
  const { context, worker } = extension;
  const result = await context.newPage();
  const base = `chrome-extension://${new URL(worker.url()).host}/result/result.html`;
  await result.goto(base);
  const id = await result.evaluate(async () => {
    const { loadFfmpeg, readFfmpegBlob, releaseFfmpeg } = await import('/result/ffmpeg.js');
    const { putRecording, putPart } = await import('/shared/idb.js');
    const ffmpeg = await loadFfmpeg(() => {});
    try {
      // Four-second GOPs put the requested split points between keyframes.
      const code = await ffmpeg.exec([
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=9',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '120', '-keyint_min', '120', '-sc_threshold', '0',
        '-c:a', 'libopus', '-f', 'matroska', 'source.webm',
      ]);
      if (code !== 0) throw Error('Could not generate long-GOP source');
      const blob = await readFfmpegBlob(ffmpeg, 'source.webm', 'video/webm');
      const id = crypto.randomUUID(), createdAt = Date.now();
      await putRecording({ id, createdAt, endedAt: createdAt + 9000, totalSize: blob.size, actualExtension: 'webm' });
      await putPart({ id: crypto.randomUUID(), recordingId: id, index: 0, filename: 'motion.webm',
        mimeType: 'video/webm', extension: 'webm', size: blob.size, blob, createdAt, seekMetadataVersion: 1 });
      return id;
    } finally { await releaseFfmpeg(); }
  });
  await result.goto(`${base}?id=${id}`);
  await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.readyState >= 2 && video.duration > 8)).toBe(true);
  await expect(result.locator('#trim-thumbnails')).not.toHaveAttribute('data-loading');
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
          video.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;z-index:2147483647';
          document.body.append(video);
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }));
          let timeout;
          try {
            const times = [];
            await new Promise((resolve, reject) => {
              timeout = setTimeout(() => reject(Error('Split video did not advance')), 8000);
              const tick = (_now, metadata) => {
                times.push(metadata.mediaTime);
                if (metadata.mediaTime >= 0.6) resolve();
                else video.requestVideoFrameCallback(tick);
              };
              video.requestVideoFrameCallback(tick);
              video.onerror = () => reject(Error('Split video failed to decode'));
              video.src = url;
              video.play().catch(reject);
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
