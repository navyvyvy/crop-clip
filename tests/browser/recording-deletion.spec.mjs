import { test, expect, prepareVideo } from './fixtures.mjs';
import { test as browserTest, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function inDatabase(worker, operation, argument = null) {
  return worker.evaluate(`(async () => {
    const opening = indexedDB.open('cropClip');
    const db = await new Promise((resolve, reject) => {
      opening.onupgradeneeded = () => opening.transaction.abort();
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const request = item => new Promise((resolve, reject) => {
      item.onsuccess = () => resolve(item.result); item.onerror = () => reject(item.error);
    });
    const done = tx => new Promise((resolve, reject) => {
      tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
    });
    try { return await (${operation.toString()})(db, ${JSON.stringify(argument)}, request, done); }
    finally { db.close(); }
  })()`);
}

test('33-second recording data expires after result close and retries failed deletion', async ({ extension }) => {
  test.setTimeout(180000);
  const { page, worker, context } = extension;
  await prepareVideo(page);
  await page.keyboard.press('e');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('recordingState')).recordingState.status)).toBe('recording');
  await page.waitForTimeout(33000);
  const opened = context.waitForEvent('page');
  await page.keyboard.press('e');
  const result = await opened;
  await expect(result.locator('#split-button')).toBeEnabled({ timeout: 30000 });
  await expect.poll(() => result.locator('#preview-video').evaluate(video => video.duration)).toBeGreaterThan(32);
  const id = new URL(result.url()).searchParams.get('id');
  const counts = id => inDatabase(worker, async (db, id, request) => {
    const tx = db.transaction(['recordings', 'parts', 'chunks']);
    const [recording, parts, chunks] = await Promise.all([
      request(tx.objectStore('recordings').get(id)), request(tx.objectStore('parts').index('recordingId').count(id)), request(tx.objectStore('chunks').index('recordingId').count(id)),
    ]);
    return { recording: Boolean(recording), parts, chunks };
  }, id);
  const alarmTime = id => worker.evaluate(async id => (await chrome.alarms.get(`delete-recording:${id}`))?.scheduledTime ?? 0, id);
  const expire = id => worker.evaluate(async id => {
    const key = `delete-recording:${id}`;
    await chrome.storage.local.set({ [key]: Date.now() - 1 });
    await chrome.alarms.create(key, { when: Date.now() });
  }, id);
  expect(await alarmTime(id)).toBeGreaterThan(Date.now() + 9 * 60000);

  // Simulate an expired heartbeat while the result remains open, as with a sleeping tab.
  await expire(id);
  await expect.poll(() => alarmTime(id)).toBeGreaterThan(Date.now() + 9 * 60000);
  expect((await counts(id)).recording).toBe(true);
  await result.close();
  expect((await counts(id)).recording).toBe(true, 'closing a result must retain the ten-minute grace period');
  expect(await alarmTime(id)).toBeGreaterThan(Date.now() + 9 * 60000);

  // Native alarms execute the production handler; only their due time is shortened.
  await expire(id);
  await expect.poll(() => counts(id), { timeout: 15000 }).toEqual({ recording: false, parts: 0, chunks: 0 });
  await expect.poll(() => worker.evaluate(async id => {
    const key = `delete-recording:${id}`;
    return (await chrome.storage.local.get(key))[key];
  }, id)).toBeUndefined();
  expect(await alarmTime(id)).toBe(0);

  const retryId = 'retry-deletion';
  await inDatabase(worker, async (db, id, _request, done) => {
    const tx = db.transaction(['recordings', 'parts', 'chunks'], 'readwrite');
    tx.objectStore('recordings').put({ id, createdAt: 1, endedAt: 2, totalSize: 4, actualExtension: 'webm' });
    tx.objectStore('parts').put({ id: 'retry-part', recordingId: id, index: 0, filename: 'retry.webm', mimeType: 'video/webm', extension: 'webm', size: 4, blob: new Blob(['part']), createdAt: 1 });
    tx.objectStore('chunks').put({ id: 'retry-chunk', recordingId: id, index: 1, mimeType: 'video/webm', extension: 'webm', baseName: 'retry', createdAt: 1, capturedAt: 2, completesBlob: true, blob: new Blob(['chunk']) });
    await done(tx);
  }, retryId);
  await worker.evaluate(() => {
    const openCursor = IDBIndex.prototype.openCursor;
    IDBIndex.prototype.openCursor = function (...args) {
      if (this.name === 'recordingId' && ['parts', 'chunks'].includes(this.objectStore.name)) {
        globalThis.testVideoValueCursors = (globalThis.testVideoValueCursors ?? 0) + 1;
      }
      return openCursor.apply(this, args);
    };
  });
  await worker.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (args[1] === 'readwrite' && Array.isArray(args[0]) && args[0].includes('recordings')) {
        IDBDatabase.prototype.transaction = transaction;
        queueMicrotask(() => tx.abort());
      }
      return tx;
    };
  });
  await expire(retryId);
  await expect.poll(() => alarmTime(retryId)).toBeGreaterThan(Date.now() + 45000);
  expect(await alarmTime(retryId)).toBeLessThan(Date.now() + 75000);
  expect(await counts(retryId)).toEqual({ recording: true, parts: 1, chunks: 1 });
  await expire(retryId);
  await expect.poll(() => counts(retryId), { timeout: 15000 }).toEqual({ recording: false, parts: 0, chunks: 0 });
  expect(await worker.evaluate(() => globalThis.testVideoValueCursors ?? 0)).toBe(0);
});

browserTest('lost deletion alarms are restored across a real browser restart', async () => {
  browserTest.setTimeout(90000);
  const directory = path.resolve(process.env.CROPCLIP_TEST_EXTENSION_DIR || 'dist');
  // IndexedDB adds long filenames under the profile on Windows.
  const profile = await mkdtemp(path.join(tmpdir(), 'cropclip-restart-'));
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: process.env.CROPCLIP_TEST_BROWSER || 'chromium', headless: true,
    args: [`--load-extension=${directory}`, `--disable-extensions-except=${directory}`],
  });
  let context;
  try {
    context = await launch();
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await expect.poll(() => inDatabase(worker, () => true).catch(() => false)).toBe(true);
    const deadline = await inDatabase(worker, async (db, _argument, _request, done) => {
      const now = Date.now();
      const tx = db.transaction(['recordings', 'parts', 'chunks'], 'readwrite');
      for (const id of ['expired', 'legacy', 'remaining']) {
        tx.objectStore('recordings').put({ id, createdAt: now - 1200000, endedAt: now - 1200000, totalSize: 4, actualExtension: 'webm' });
        tx.objectStore('parts').put({ id: `${id}-part`, recordingId: id, index: 0, filename: `${id}.webm`, mimeType: 'video/webm', extension: 'webm', size: 4, blob: new Blob(['part']), createdAt: 1 });
        tx.objectStore('chunks').put({ id: `${id}-chunk`, recordingId: id, index: 1, mimeType: 'video/webm', extension: 'webm', baseName: id, createdAt: 1, capturedAt: 2, completesBlob: true, blob: new Blob(['chunk']) });
      }
      tx.objectStore('parts').put({ id: 'orphan-part', recordingId: 'orphan-part', blob: new Blob(['part']) });
      tx.objectStore('chunks').put({ id: 'orphan-chunk', recordingId: 'orphan-chunk', blob: new Blob(['chunk']) });
      tx.objectStore('chunks').put({ id: 'recovering-chunk', recordingId: 'recovering', index: 1, mimeType: 'video/webm', extension: 'webm', baseName: 'recovering', createdAt: now, capturedAt: now, completesBlob: false, blob: new Blob(['chunk']) });
      await done(tx);
      const deadline = now + 300000;
      await chrome.storage.local.set({ recordingState: { status: 'error', recordingId: 'recovering' }, 'delete-recording:expired': now - 1, 'delete-recording:remaining': deadline });
      await chrome.alarms.clearAll();
      return deadline;
    });
    await context.close();
    context = await launch();
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const counts = () => inDatabase(worker, async (db, _argument, request) => {
      const tx = db.transaction(['recordings', 'parts', 'chunks']);
      const [ids, expiredParts, expiredChunks, legacyParts, legacyChunks, orphanParts, orphanChunks, recoveryChunks] = await Promise.all([
        request(tx.objectStore('recordings').getAllKeys()),
        request(tx.objectStore('parts').index('recordingId').count('expired')), request(tx.objectStore('chunks').index('recordingId').count('expired')),
        request(tx.objectStore('parts').index('recordingId').count('legacy')), request(tx.objectStore('chunks').index('recordingId').count('legacy')),
        request(tx.objectStore('parts').index('recordingId').count('orphan-part')), request(tx.objectStore('chunks').index('recordingId').count('orphan-chunk')),
        request(tx.objectStore('chunks').index('recordingId').count('recovering')),
      ]);
      return {
        ids: ids.sort(), expiredParts, expiredChunks, legacyParts, legacyChunks, orphanParts, orphanChunks, recoveryChunks,
      };
    });
    await expect.poll(counts, { timeout: 15000 }).toEqual({ ids: ['remaining'], expiredParts: 0, expiredChunks: 0, legacyParts: 0, legacyChunks: 0, orphanParts: 1, orphanChunks: 1, recoveryChunks: 1 });
    expect(await worker.evaluate(async () => (await chrome.alarms.get('delete-recording:remaining'))?.scheduledTime)).toBe(deadline);
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('delete-recording:expired'))['delete-recording:expired'])).toBeUndefined();
    for (const id of ['orphan-part', 'orphan-chunk', 'recovering']) {
      expect(await worker.evaluate(async id => (await chrome.storage.local.get(`delete-recording:${id}`))[`delete-recording:${id}`], id)).toBeGreaterThan(Date.now() + 9 * 60000);
      await worker.evaluate(async id => {
        const key = `delete-recording:${id}`;
        await chrome.storage.local.set({ [key]: Date.now() - 1 });
        await chrome.alarms.create(key, { when: Date.now() });
      }, id);
    }
    await expect.poll(counts, { timeout: 15000 }).toEqual({ ids: ['remaining'], expiredParts: 0, expiredChunks: 0, legacyParts: 0, legacyChunks: 0, orphanParts: 0, orphanChunks: 0, recoveryChunks: 1 });
    await expect.poll(() => worker.evaluate(async () => (await chrome.alarms.get('delete-recording:recovering'))?.scheduledTime ?? 0)).toBeGreaterThan(Date.now() + 9 * 60000);
  } finally {
    try {
      await context?.close();
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});
