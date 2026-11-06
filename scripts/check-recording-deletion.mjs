import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('service_worker.ts', fs.readFileSync(new URL('../src/background/service_worker.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['getDeleteAlarmName', 'scheduleRecordingDeletion', 'deleteRecordingNow', 'deleteRecordingEventually', 'findRecordingResultTab', 'restoreScheduledRecordingDeletions', 'handleRecordingDeletion'];
const code = ts.transpile(source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
function fixture() {
  const env = { now: 2000000, stored: {}, alarms: new Map(), recordings: [], tabs: [], deleted: [], state: { status: 'idle' }, failDelete: false };
  const chrome = {
    storage: { local: {
      async get(key) { return key === null ? { ...env.stored } : { [key]: env.stored[key] }; },
      async set(values) { Object.assign(env.stored, values); },
      async remove(key) { delete env.stored[key]; },
    } },
    alarms: {
      async create(name, options) { env.alarms.set(name, { name, scheduledTime: options.when ?? env.now + options.delayInMinutes * 60000 }); },
      async clear(name) { return env.alarms.delete(name); },
      async get(name) { return env.alarms.get(name); },
      async getAll() { return [...env.alarms.values()]; },
    },
    runtime: { getURL: path => `chrome-extension://test/${path}`, ContextType: { TAB: 'TAB' }, async getContexts() { return env.tabs; } },
  };
  const api = new Function('env', 'chrome', `
    const Date = { now: () => env.now };
    const DELETE_AFTER_MINUTES = 10, DELETE_ALARM_PREFIX = 'delete-recording:';
    const DELETE_RETRY_MINUTES = 1;
    const MILLISECONDS_PER_SECOND = 1000, SECONDS_PER_MINUTE = 60;
    const RECORDING_STATUS = { idle: 'idle' };
    const ok = () => ({ ok: true });
    const getRecordingDeletionCandidates = async () => env.recordings;
    const loadRecordingState = async () => env.state;
    const runRecordingTerminalOperation = (_id, operation) => operation();
    const deleteRecording = async id => {
      if (env.failDelete) throw Error('storage unavailable');
      env.deleted.push(id); env.recordings = env.recordings.filter(record => record.id !== id);
    };
    ${code}
    return { scheduleRecordingDeletion, deleteRecordingEventually,
      restore: typeof restoreScheduledRecordingDeletions === 'function' ? restoreScheduledRecordingDeletions : undefined,
      expire: typeof handleRecordingDeletion === 'function' ? handleRecordingDeletion : undefined };
  `)(env, chrome);
  return { env, api };
}

const key = 'delete-recording:clip';
{
  const { env, api } = fixture();
  env.recordings = [{ id: 'orphan' }];
  await api.restore();
  const deadline = env.stored['delete-recording:orphan'];
  assert.equal(deadline, env.now + 600000, 'unknown-age fragments must get one durable grace period');
  env.now += 1000;
  env.alarms.clear();
  await api.restore();
  assert.equal(env.stored['delete-recording:orphan'], deadline, 'restarts cannot renew orphan retention indefinitely');
  env.now = deadline + 1;
  env.alarms.clear();
  await api.restore();
  assert.deepEqual(env.deleted, ['orphan']);
}
{
  const { env, api } = fixture();
  await api.scheduleRecordingDeletion('clip');
  assert.equal(env.stored[key], env.now + 600000, 'the ten-minute deadline must survive loss of browser alarms');
  const deadline = env.stored[key];
  env.alarms.clear();
  await api.restore();
  assert.equal(env.alarms.get(key).scheduledTime, deadline, 'restore the remaining deadline, not a fresh ten minutes');
  env.now += 1000;
  await api.scheduleRecordingDeletion('clip');
  assert.equal(Object.keys(env.stored).length, 1, 'renewal must update the existing lease');
  await api.expire('clip');
  assert.deepEqual(env.deleted, [], 'an early alarm must not bypass the persisted deadline');
  env.now = env.stored[key] + 1;
  env.tabs = [{ documentUrl: 'chrome-extension://test/result/result.html?id=clip', tabId: 7 }];
  await api.expire('clip');
  assert.deepEqual(env.deleted, [], 'an open or sleeping result tab must keep its data');
  assert.equal(env.stored[key], env.now + 600000);
  env.tabs = [];
  env.now = env.stored[key] + 1;
  await api.expire('clip');
  assert.deepEqual(env.deleted, ['clip']);
  assert.equal(env.alarms.has(key), false);
  assert.equal(key in env.stored, false, 'completed deletion must also remove lease metadata');
}
{
  const { env, api } = fixture();
  env.recordings = [{ id: 'legacy', endedAt: env.now - 700000 }];
  env.stored['settings'] = { enableShortcuts: true };
  await api.restore();
  assert.deepEqual(env.deleted, ['legacy'], 'old completed records without alarms must be reclaimed');
  assert.equal(env.alarms.has('settings'), false);
  env.deleted = [];
  env.recordings = [{ id: 'legacy', endedAt: env.now - 700000 }];
  env.state = { status: 'error', recordingId: 'legacy' };
  await api.restore();
  assert.deepEqual(env.deleted, [], 'recovery data for the current recording must remain protected');
}
{
  const { env, api } = fixture();
  await api.scheduleRecordingDeletion('clip');
  env.failDelete = true;
  await api.deleteRecordingEventually('clip');
  assert.ok(env.stored[key]);
  assert.ok(env.alarms.has(key), 'failed deletion must retain a retry and its durable lease');
  env.failDelete = false;
  env.now = env.stored[key] + 1;
  await api.expire('clip');
  assert.deepEqual(env.deleted, ['clip']);
}
console.log('recording retention, restart recovery and deletion protection checks passed');
