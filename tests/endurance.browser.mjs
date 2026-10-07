import { HeartRateStore } from '../assets/storage.js';
import { BoundedSeries } from '../assets/core.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deleteTestDatabase(name) {
  assert(name.startsWith('heart-rate-endurance-test-'), 'Refuse to delete a non-test database');
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Endurance test database cleanup was blocked'));
  });
}

/** Two hours of 1 Hz samples on four independent sessions, committed to real IndexedDB. */
export async function runEnduranceTest() {
  const name = `heart-rate-endurance-test-${crypto.randomUUID()}`;
  const sampleCount = 7200;
  const began = Date.UTC(2026, 9, 7);
  const endedAt = began + sampleCount * 1000;
  let store = new HeartRateStore(name);
  const series = Array.from({ length: 4 }, () => new BoundedSeries());
  let maximumLivePoints = 0;
  try {
    await store.open();
    const sessions = await Promise.all(Array.from({ length: 4 }, (_, slotId) => store.createSession({
      slotId, machine: `耐久測試機台 ${slotId + 1}`, deviceName: `模擬手錶 ${slotId + 1}`,
      source: 'demo', maxHR: 190, startedAt: began,
    })));

    // Only one batch is in flight: every sample transaction has committed before
    // advancing the simulated second. No timer acceleration or mocked storage.
    for (let step = 0; step < sampleCount; step++) {
      const timestamp = began + (step + 1) * 1000;
      const saved = await Promise.all(sessions.map((session, index) => {
        const bpm = 60 + index * 20 + step % 40;
        series[index].push(timestamp, bpm);
        const pointCount = series[index].points.length;
        maximumLivePoints = Math.max(maximumLivePoints, pointCount);
        assert(pointCount <= 61, `Slot ${index + 1} exceeded its 60-second live buffer at sample ${step + 1}`);
        return store.appendSample(session.id, { timestamp, bpm });
      }));
      for (let index = 0; index < saved.length; index++) {
        assert(saved[index].count === step + 1, `Slot ${index + 1} failed to commit sample ${step + 1}`);
      }
    }

    async function verifyPersisted(expectedStatus) {
      const listed = await store.listSessions();
      assert(listed.length === 4, 'Exactly four isolated sessions must exist');
      let total = 0;
      for (let index = 0; index < sessions.length; index++) {
        const { session, events } = await store.getSessionSnapshot(sessions[index].id);
        const base = 60 + index * 20;
        // 7200 samples contain 180 complete cycles of the independent range 0..39.
        const expectedSum = sampleCount * base + 180 * (39 * 40 / 2);
        assert(session.slotId === index && session.source === 'demo', `Slot ${index + 1} metadata was mixed`);
        assert(session.status === expectedStatus, `Slot ${index + 1} has the wrong completion state`);
        assert(session.count === sampleCount && events.length === sampleCount, `Slot ${index + 1} lost or duplicated persisted samples`);
        assert(session.min === base && session.max === base + 39 && session.sum === expectedSum, `Slot ${index + 1} has incorrect persisted statistics`);
        assert(session.lastSampleAt === endedAt, `Slot ${index + 1} has the wrong final timestamp`);
        for (let step = 0; step < events.length; step++) {
          assert(events[step].sessionId === session.id && events[step].timestamp === began + (step + 1) * 1000
            && events[step].bpm === base + step % 40, `Slot ${index + 1} sample ${step + 1} is incorrect`);
        }
        if (expectedStatus === 'completed') assert(session.endedAt === endedAt, `Slot ${index + 1} has the wrong end time`);
        total += events.length;
      }
      assert(total === 28800, 'Four sessions must contain exactly 28,800 persisted samples');
      return total;
    }

    await verifyPersisted('recording');
    await Promise.all(sessions.map(session => store.finishSession(session.id, { status: 'completed', endedAt })));
    store.close();
    store = new HeartRateStore(name);
    await store.open();
    const totalSamples = await verifyPersisted('completed');
    assert(await store.recoverInterrupted() === 0, 'Reopening must not change completed recordings');
    assert(series.every(buffer => buffer.points.length === 61), 'All four live buffers must retain exactly the final 61 points at 1 Hz');
    return { passed: true, equivalentHours: 2, sessions: 4, samplesPerSession: sampleCount, totalSamples, maximumLivePoints };
  } finally {
    store.close();
    await deleteTestDatabase(name);
  }
}
