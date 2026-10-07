import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionCsv } from '../assets/storage.js';

const session = {
  id: 'record-1', source: 'demo', slotId: 2, machine: '下肢, "測試"',
  deviceName: '=HYPERLINK("https://example.test")', startedAt: Date.UTC(2026, 9, 7),
};

test('CSV includes BOM, source, ISO UTC, fractional elapsed seconds and CRLF', () => {
  const csv = sessionCsv(session, [{ timestamp: session.startedAt + 1234, bpm: 88 }]);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('"模擬","3"'));
  assert.ok(csv.includes('"2026-10-07T00:00:01.234Z","1.234","88"'));
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.split('\r\n').length, 3);
});

test('CSV quotes delimiters and embedded quotes, neutralizes quoted formulas', () => {
  const csv = sessionCsv(session, [{ timestamp: session.startedAt, bpm: 75 }]);
  assert.ok(csv.includes('"下肢, ""測試"""'));
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.test"")"'));
  for (const deviceName of ['+SUM(1,2)', '-1+1', '@SUM(A1)', ' \t=1+1', '\n@foo', '\tordinary']) {
    const guarded = sessionCsv({ ...session, deviceName }, [{ timestamp: session.startedAt, bpm: 90 }]);
    assert.ok(guarded.includes(`"'${deviceName}"`), deviceName);
  }
});

test('CSV preserves normal Unicode names and includes no fabricated samples for gaps', () => {
  const csv = sessionCsv({ ...session, source: 'ble', deviceName: '手錶 A' }, [
    { timestamp: session.startedAt, bpm: null, reason: '斷線' },
    { timestamp: session.startedAt + 1000, bpm: 0 },
    { timestamp: session.startedAt + 2000, bpm: 101 },
  ]);
  assert.ok(csv.includes('"藍牙"'));
  assert.ok(csv.includes('"手錶 A"'));
  assert.equal(csv.split('\r\n').length, 3);
});

test('CSV with no samples contains header only', () => {
  assert.equal(sessionCsv(session, []).split('\r\n').length, 2);
});

test('CSV machine numbers use the user-facing range 1 through 4', () => {
  for (let slotId = 0; slotId < 4; slotId++) {
    const csv = sessionCsv({ ...session, slotId }, [{ timestamp: session.startedAt, bpm: 80 }]);
    assert.ok(csv.includes(`"模擬","${slotId + 1}"`));
  }
});
