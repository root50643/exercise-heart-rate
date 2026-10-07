import test from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_CONFIGS, parseHeartRateMeasurement, getZone, BoundedSeries } from '../assets/core.js';

const packet = (...bytes) => new DataView(Uint8Array.from(bytes).buffer);

test('heart rate packets support 8/16-bit little endian, contact, energy and RR fields', () => {
  assert.deepEqual(parseHeartRateMeasurement(packet(0, 72)), { bpm: 72, contact: null, rrIntervals: [] });
  assert.deepEqual(parseHeartRateMeasurement(packet(1, 44, 1)), { bpm: 300, contact: null, rrIntervals: [] });
  assert.deepEqual(parseHeartRateMeasurement(packet(4, 90)), { bpm: 90, contact: false, rrIntervals: [] });
  assert.deepEqual(parseHeartRateMeasurement(packet(6, 90)), { bpm: 90, contact: true, rrIntervals: [] });
  assert.deepEqual(parseHeartRateMeasurement(packet(0x1f, 244, 1, 20, 0, 0, 4, 0, 2)), {
    bpm: 500, contact: true, rrIntervals: [1, 0.5],
  });
  assert.equal(parseHeartRateMeasurement(packet(0, 0)).bpm, 0);
});

test('parser honours DataView offsets and rejects all truncated optional fields', () => {
  const bytes = Uint8Array.from([255, 1, 44, 1, 255]);
  assert.equal(parseHeartRateMeasurement(new DataView(bytes.buffer, 1, 3)).bpm, 300);
  for (const value of [null, [], packet(), packet(0), packet(1, 30), packet(8, 60, 1), packet(16, 60), packet(16, 60, 1), packet(0, 60, 1)]) {
    assert.throws(() => parseHeartRateMeasurement(value), Error);
  }
});

test('zone reference remains optional and thresholds use exact percentages', () => {
  for (const maximum of [undefined, null, '', 'abc', 0, -1, Infinity]) assert.equal(getZone(90, maximum), null);
  for (const [bpm, zone] of [[99, '50% 以下'], [100, 'Z1'], [120, 'Z2'], [140, 'Z3'], [160, 'Z4'], [180, 'Z5'], [250, 'Z5']]) {
    assert.equal(getZone(bpm, 200).name, zone);
  }
  assert.equal(getZone(119, 200).name, 'Z1');
  assert.equal(getZone(0, 200), null);
});

test('fixed machines match right-top, left-bottom, left-top, right-bottom', () => {
  assert.deepEqual(SLOT_CONFIGS.map((slot) => [slot.id, slot.crop.sx, slot.crop.sy]), [
    [0, 0.5, 0], [1, 0, 0.5], [2, 0, 0], [3, 0.5, 0.5],
  ]);
});

test('chart data keeps explicit gaps, a bounded clock window and independent snapshots', () => {
  const series = new BoundedSeries({ windowMs: 60000, maxPoints: 5 });
  series.push(0, 80);
  series.gap(1000);
  series.gap(2000);
  series.push(3000, 90);
  assert.deepEqual(series.points, [{ x: 0, y: 80 }, { x: 1000, y: null }, { x: 3000, y: 90 }]);
  series.points[0].y = 1000;
  assert.equal(series.points[0].y, 80);
  series.push(2500, 91); // System clock goes backwards.
  assert.equal(series.points.at(-1).x, 3000);
  series.trim(63001);
  assert.equal(series.points.length, 0);
  series.push(64000, 80);
  series.clear();
  assert.equal(series.points.length, 0);
});

test('four two-hour equivalent streams remain bounded and preserve sample counts', () => {
  const series = Array.from({ length: 4 }, () => new BoundedSeries());
  const counts = [0, 0, 0, 0];
  for (let second = 0; second < 7200; second++) {
    for (let slot = 0; slot < 4; slot++) {
      series[slot].push(second * 1000, 60 + slot + second % 100);
      counts[slot]++;
      assert.ok(series[slot].points.length <= 61);
    }
  }
  assert.deepEqual(counts, [7200, 7200, 7200, 7200]);
  const highRate = new BoundedSeries({ maxPoints: 1200 });
  for (let i = 0; i < 5000; i++) highRate.push(i, 90);
  assert.equal(highRate.points.length, 1200);
});
