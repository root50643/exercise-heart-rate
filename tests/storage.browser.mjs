import { HeartRateStore } from '../assets/storage.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rejects(operation, message) {
  let failed = false;
  try { await operation(); } catch { failed = true; }
  assert(failed, message);
}

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Test database blocked'));
  });
}

/** Run in a real browser on the app origin; each run uses and deletes an isolated database. */
export async function runStorageTests() {
  const name = `heart-rate-test-${crypto.randomUUID()}`;
  let store = new HeartRateStore(name);
  const passed = [];
  try {
    await store.open();
    const began = Date.UTC(2026, 9, 7);
    await store.setSetting('maxHR', [185, null, 190, 200]);
    const session = await store.createSession({ slotId: 1, machine: '划船', deviceName: 'Watch', source: 'ble', maxHR: 185, startedAt: began });
    const other = await store.createSession({ slotId: 2, machine: '腳踏車', deviceName: 'Demo', source: 'demo', startedAt: began + 1 });
    await Promise.all([
      store.appendSample(session.id, { timestamp: began + 1000, bpm: 80 }),
      store.appendSample(session.id, { timestamp: began + 2000, bpm: 100 }),
      store.appendSample(session.id, { timestamp: began + 3000, bpm: 90 }),
    ]);
    await store.appendGap(session.id, { timestamp: began + 3500, reason: '逾時' });
    await store.appendSample(other.id, { timestamp: began + 2000, bpm: 120 });
    let saved = await store.getSession(session.id);
    assert(saved.count === 3 && saved.sum === 270 && saved.min === 80 && saved.max === 100 && saved.lastSampleAt === began + 3000, 'Atomic sample summaries must remain correct across concurrent writes');
    assert((await store.getSession(other.id)).count === 1, 'Sessions must remain isolated');
    assert((await store.getEvents(session.id)).length === 4, 'Gap events must persist');
    assert((await store.getSamples(session.id)).length === 3, 'Gap events must not count as BPM samples');
    passed.push('Concurrent atomic summaries, session isolation, historical gaps');

    const snapshot = await store.getSessionSnapshot(session.id);
    assert(snapshot.session.count === 3 && snapshot.events.length === 4, 'Snapshot must include summary and gap events');
    assert(snapshot.events.every((row, i, rows) => i === 0 || row.timestamp >= rows[i - 1].timestamp), 'Snapshot events must be chronological');
    const concurrentSnapshotSession = await store.createSession({ slotId: 3, machine: '快照測試', source: 'demo', startedAt: began });
    const operations = [];
    for (let i = 1; i <= 20; i++) {
      operations.push(store.appendSample(concurrentSnapshotSession.id, { timestamp: began + i, bpm: 80 + i }));
      operations.push(store.getSessionSnapshot(concurrentSnapshotSession.id).then(view => {
        const values = view.events.filter(row => row.bpm !== null);
        assert(view.session.count === values.length, 'Snapshot count must match rows during concurrent recording');
        assert(view.session.sum === values.reduce((sum, row) => sum + row.bpm, 0), 'Snapshot summary must match rows during concurrent recording');
      }));
    }
    await Promise.all(operations);
    await store.finishSession(concurrentSnapshotSession.id, { endedAt: began + 20 });
    await store.deleteSession(concurrentSnapshotSession.id);
    const missingSnapshot = await store.getSessionSnapshot('does-not-exist');
    assert(missingSnapshot.session === null && missingSnapshot.events.length === 0, 'Missing snapshot must return a null session and empty events');
    passed.push('Consistent session snapshots during concurrent recording');

    await rejects(() => store.appendSample(session.id, { timestamp: began - 1, bpm: 200 }), 'Pre-start timestamp must reject');
    await rejects(() => store.appendSample(session.id, { timestamp: began + 4000, bpm: 0 }), 'Zero BPM must reject');
    await rejects(() => store.appendSample(session.id, { timestamp: began + 4000, bpm: NaN }), 'NaN BPM must reject');
    saved = await store.getSession(session.id);
    assert(saved.count === 3 && (await store.getSamples(session.id)).length === 3, 'Rejected sample must not change summary or events');
    await rejects(() => store.deleteSession(session.id), 'Active recording must not be deleted');
    passed.push('Failed writes leave summary and samples unchanged');

    // Force an IDB request failure after the event add. Both event and summary must roll back.
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'sessions' && value.id === session.id && value.count === 4) return this.add(value);
      return originalPut.call(this, value, ...args);
    };
    try {
      await rejects(() => store.appendSample(session.id, { timestamp: began + 4500, bpm: 150 }), 'IDB constraint failure must reject');
    } finally { IDBObjectStore.prototype.put = originalPut; }
    saved = await store.getSession(session.id);
    assert(saved.count === 3 && saved.sum === 270 && (await store.getEvents(session.id)).length === 4, 'IDB failure must roll back event and summary together');
    passed.push('IDB request failure rolls back the whole transaction');

    await store.finishSession(other.id, { status: 'completed', endedAt: began + 5000 });
    store.close();
    store = new HeartRateStore(name);
    await store.open();
    assert((await store.getSetting('maxHR'))[0] === 185, 'Settings must persist across reopening');
    assert((await store.getSamples(session.id)).length === 3, 'Samples must persist across reopening');
    assert(await store.recoverInterrupted() === 1, 'Only active recordings should recover as interrupted');
    saved = await store.getSession(session.id);
    assert(saved.status === 'interrupted' && saved.endedAt === began + 3000, 'Recovery must stop at last saved sample, not fabricated wall time');
    assert((await store.getSession(other.id)).status === 'completed', 'Completed recording must survive recovery');
    assert(await store.recoverInterrupted() === 0, 'Recovery must be idempotent');
    assert((await store.listSessions())[0].id === other.id, 'History must sort newest first');
    passed.push('Persistence, recovery and history ordering');

    await rejects(() => store.appendSample(session.id, { timestamp: began + 6000, bpm: 85 }), 'Finished recording must reject samples');
    await rejects(() => store.appendGap(session.id, { timestamp: began + 6000 }), 'Finished recording must reject gaps');
    const finished = await store.finishSession(session.id, { status: 'completed', endedAt: began + 9000 });
    assert(finished.status === 'interrupted' && finished.endedAt === saved.endedAt, 'Repeated finish must not mutate history');
    const empty = await store.createSession({ slotId: 3, machine: '健腹', source: 'demo', startedAt: began + 10000 });
    await store.recoverInterrupted();
    assert((await store.getSession(empty.id)).endedAt === empty.startedAt, 'Empty interrupted recording must end at start');
    passed.push('Finished history remains immutable and empty recovery is safe');

    await store.deleteSession(session.id);
    assert(await store.getSession(session.id) === undefined, 'Deleted session must disappear');
    assert((await store.getEvents(session.id)).length === 0, 'Deletion must include all session events');
    assert((await store.getSamples(other.id)).length === 1, 'Deleting one recording must preserve others');
    passed.push('Atomic deletion and isolation');
    return passed;
  } finally {
    store.close();
    await deleteDatabase(name);
  }
}
