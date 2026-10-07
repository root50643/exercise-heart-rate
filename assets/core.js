/** Fixed quadrant coordinates are fractions of the supplied source image. */
export const SLOT_CONFIGS = Object.freeze([
  { id: 0, name: '划船／上肢機台', color: '#3b82f6', crop: { sx: 0.5, sy: 0, sw: 0.5, sh: 0.5 } },
  { id: 1, name: '騎自行車／下肢機台', color: '#10b981', crop: { sx: 0, sy: 0.5, sw: 0.5, sh: 0.5 } },
  { id: 2, name: '仰臥起坐／健腹器', color: '#f43f5e', crop: { sx: 0, sy: 0, sw: 0.5, sh: 0.5 } },
  { id: 3, name: '健走／踩步機', color: '#a855f7', crop: { sx: 0.5, sy: 0.5, sw: 0.5, sh: 0.5 } },
]);

/** Bluetooth SIG Heart Rate Measurement 0x2A37. RR intervals are in seconds. */
export function parseHeartRateMeasurement(value) {
  if (!(value instanceof DataView) || value.byteLength < 2) {
    throw new Error('心率封包不完整');
  }
  const flags = value.getUint8(0);
  let offset = 1;
  const need = (bytes) => {
    if (offset + bytes > value.byteLength) throw new Error('心率封包不完整');
  };
  const uint16 = () => {
    need(2);
    const result = value.getUint16(offset, true);
    offset += 2;
    return result;
  };
  const bpm = flags & 1 ? uint16() : value.getUint8(offset++);
  const contact = flags & 4 ? Boolean(flags & 2) : null;
  if (flags & 8) uint16(); // Energy Expended is optional and not used by this dashboard.
  const rrIntervals = [];
  if (flags & 16) {
    if (offset === value.byteLength) throw new Error('心率封包缺少 RR 間隔');
    while (offset < value.byteLength) rrIntervals.push(uint16() / 1024);
  }
  if (offset !== value.byteLength) throw new Error('心率封包長度不符');
  return { bpm, contact, rrIntervals };
}

/** Reference percentages only; these labels do not make fitness/medical claims. */
export function getZone(bpm, maxHR) {
  const maximum = Number(maxHR);
  if (!Number.isFinite(maximum) || maximum <= 0 || !Number.isFinite(bpm) || bpm <= 0) return null;
  const ratio = bpm / maximum * 100;
  const percent = Math.round(ratio);
  if (ratio < 50) return { name: '50% 以下', percent, color: '#94a3b8' };
  if (ratio < 60) return { name: 'Z1', percent, color: '#60a5fa' };
  if (ratio < 70) return { name: 'Z2', percent, color: '#34d399' };
  if (ratio < 80) return { name: 'Z3', percent, color: '#facc15' };
  if (ratio < 90) return { name: 'Z4', percent, color: '#fb923c' };
  return { name: 'Z5', percent, color: '#fb7185' };
}

/** Chronological Chart.js-compatible samples. Null points explicitly break lines. */
export class BoundedSeries {
  constructor({ windowMs = 60_000, maxPoints = 1200 } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isInteger(maxPoints) || maxPoints < 2) {
      throw new Error('圖表緩衝設定無效');
    }
    this.windowMs = windowMs;
    this.maxPoints = maxPoints;
    this._points = [];
  }

  push(timestamp, bpm) {
    if (!Number.isFinite(timestamp) || !Number.isFinite(bpm) || bpm <= 0) return;
    this._append(timestamp, bpm);
  }

  gap(timestamp) {
    if (!Number.isFinite(timestamp)) return;
    // A single null is sufficient for a continuous missing-data period.
    if (this._points.at(-1)?.y === null) {
      this.trim(timestamp);
      return;
    }
    this._append(timestamp, null);
  }

  _append(timestamp, bpm) {
    const last = this._points.at(-1);
    // Clock corrections must not leave unsorted points for Chart.js parsing:false.
    const x = Math.max(timestamp, last?.x ?? timestamp);
    this._points.push({ x, y: bpm });
    this.trim(x);
  }

  trim(now) {
    const cutoff = now - this.windowMs;
    let start = 0;
    while (start < this._points.length && this._points[start].x < cutoff) start++;
    start = Math.max(start, this._points.length - this.maxPoints);
    if (start > 0) this._points.splice(0, start);
  }

  clear() { this._points.length = 0; }
  get points() { return this._points.map((point) => ({ ...point })); }
}
