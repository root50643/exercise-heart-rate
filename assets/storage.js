const DATABASE_VERSION = 1;
const DEFAULT_DATABASE = 'exercise-heart-rate';

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('瀏覽器儲存空間不足，請先匯出並刪除舊紀錄。', { cause: error });
  return new Error(`無法存取本機紀錄${error?.message ? `：${error.message}` : '。'}`, { cause: error });
}

function assertTime(value, label = '時間') {
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) throw new Error(`${label}格式無效。`);
}

function sessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** All timestamps are milliseconds since the Unix epoch. No active session cache is kept. */
export class HeartRateStore {
  constructor(name = DEFAULT_DATABASE) {
    this.name = name;
    this.db = null;
    this.opening = null;
    this.generation = 0;
  }

  async open() {
    if (this.db) return this;
    if (this.opening) return this.opening;
    if (!globalThis.indexedDB) throw new Error('此瀏覽器不支援 IndexedDB，無法保存運動紀錄。');
    const generation = this.generation;
    this.opening = new Promise((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(this.name, DATABASE_VERSION);
      const rejectOnce = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('settings', { keyPath: 'key' });
        db.createObjectStore('sessions', { keyPath: 'id' });
        const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        events.createIndex('sessionId', 'sessionId');
      };
      request.onblocked = () => rejectOnce(new Error('另一個分頁正在使用舊版紀錄資料庫，請關閉該分頁後重新載入。'));
      request.onerror = () => rejectOnce(storageError(request.error));
      request.onsuccess = () => {
        const db = request.result;
        if (settled || generation !== this.generation) {
          db.close();
          rejectOnce(new Error('資料庫連線已取消。'));
          return;
        }
        if (!['settings', 'sessions', 'events'].every(name => db.objectStoreNames.contains(name))) {
          db.close();
          rejectOnce(new Error('本機紀錄資料庫格式不相容，請保留資料並聯絡維護人員。'));
          return;
        }
        this.db = db;
        db.onversionchange = () => {
          db.close();
          if (this.db === db) this.db = null;
        };
        settled = true;
        resolve(this);
      };
    });
    try { return await this.opening; }
    finally { this.opening = null; }
  }

  close() {
    this.generation += 1;
    this.db?.close();
    this.db = null;
  }

  async transaction(names, mode, run) {
    await this.open();
    return new Promise((resolve, reject) => {
      let result;
      let failure;
      let tx;
      try { tx = this.db.transaction(names, mode); }
      catch (error) { reject(storageError(error)); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? storageError(tx.error));
      tx.onerror = () => { /* The abort event reports the final transaction result. */ };
      const fail = error => {
        failure = error;
        try { tx.abort(); } catch { reject(error); }
      };
      try { run(tx, value => { result = value; }, fail); }
      catch (error) { fail(storageError(error)); }
    });
  }

  async getSetting(key) {
    return this.transaction(['settings'], 'readonly', (tx, done) => {
      tx.objectStore('settings').get(key).onsuccess = event => done(event.target.result?.value);
    });
  }

  async setSetting(key, value) {
    return this.transaction(['settings'], 'readwrite', (tx, done) => {
      tx.objectStore('settings').put({ key, value });
      done(value);
    });
  }

  async createSession({ slotId, machine, deviceName, source, maxHR = null, startedAt = Date.now() }) {
    assertTime(startedAt, '開始時間');
    if (!['ble', 'demo'].includes(source)) throw new Error('紀錄來源無效。');
    if (maxHR !== null && (!Number.isFinite(maxHR) || maxHR <= 0)) throw new Error('參考最大心率無效。');
    const session = {
      id: sessionId(), slotId, machine: String(machine ?? ''), deviceName: String(deviceName ?? ''),
      source, maxHR, startedAt, endedAt: null, status: 'recording', reason: null,
      count: 0, sum: 0, min: null, max: null, lastSampleAt: null,
    };
    return this.transaction(['sessions'], 'readwrite', (tx, done) => {
      tx.objectStore('sessions').add(session);
      done(session);
    });
  }

  async appendSample(id, { timestamp, bpm }) {
    assertTime(timestamp);
    if (!Number.isInteger(bpm) || bpm <= 0 || bpm > 65535) throw new Error('心率樣本必須是有效的正整數。');
    return this.appendEvent(id, { timestamp, bpm });
  }

  async appendGap(id, { timestamp, reason = '資料中斷' }) {
    assertTime(timestamp);
    return this.appendEvent(id, { timestamp, bpm: null, reason: String(reason) });
  }

  async appendEvent(id, data) {
    return this.transaction(['sessions', 'events'], 'readwrite', (tx, done, fail) => {
      const sessions = tx.objectStore('sessions');
      sessions.get(id).onsuccess = event => {
        try {
          const session = event.target.result;
          if (!session) { fail(new Error('找不到運動紀錄。')); return; }
          if (session.status !== 'recording') { fail(new Error('紀錄已結束，不能再加入樣本。')); return; }
          if (data.timestamp < session.startedAt) { fail(new Error('樣本時間不能早於紀錄開始時間。')); return; }
          if (data.bpm !== null) {
            session.count += 1;
            session.sum += data.bpm;
            session.min = session.min === null ? data.bpm : Math.min(session.min, data.bpm);
            session.max = session.max === null ? data.bpm : Math.max(session.max, data.bpm);
            session.lastSampleAt = Math.max(session.lastSampleAt ?? session.startedAt, data.timestamp);
          }
          tx.objectStore('events').add({ sessionId: id, ...data });
          sessions.put(session);
          done(session);
        } catch (error) { fail(storageError(error)); }
      };
    });
  }

  async finishSession(id, { status = 'completed', reason = null, endedAt = Date.now() } = {}) {
    assertTime(endedAt, '結束時間');
    if (!['completed', 'interrupted'].includes(status)) throw new Error('紀錄完成狀態無效。');
    return this.transaction(['sessions'], 'readwrite', (tx, done, fail) => {
      const sessions = tx.objectStore('sessions');
      sessions.get(id).onsuccess = event => {
        const session = event.target.result;
        if (!session) { fail(new Error('找不到運動紀錄。')); return; }
        if (session.status === 'recording') {
          session.status = status;
          session.reason = reason;
          session.endedAt = Math.max(endedAt, session.lastSampleAt ?? session.startedAt, session.startedAt);
          sessions.put(session);
        }
        done(session);
      };
    });
  }

  async recoverInterrupted() {
    return this.transaction(['sessions'], 'readwrite', (tx, done) => {
      let count = 0;
      tx.objectStore('sessions').openCursor().onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) { done(count); return; }
        const session = cursor.value;
        if (session.status === 'recording') {
          session.status = 'interrupted';
          session.reason = '頁面未正常結束';
          session.endedAt = session.lastSampleAt ?? session.startedAt;
          cursor.update(session);
          count += 1;
        }
        cursor.continue();
      };
    });
  }

  async getSession(id) {
    return this.transaction(['sessions'], 'readonly', (tx, done) => {
      tx.objectStore('sessions').get(id).onsuccess = event => done(event.target.result);
    });
  }

  async listSessions() {
    return this.transaction(['sessions'], 'readonly', (tx, done) => {
      tx.objectStore('sessions').getAll().onsuccess = event => done(event.target.result.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)));
    });
  }

  async getEvents(id) {
    return this.transaction(['events'], 'readonly', (tx, done) => {
      tx.objectStore('events').index('sessionId').getAll(IDBKeyRange.only(id)).onsuccess = event => {
        done(event.target.result.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id));
      };
    });
  }

  async getSessionSnapshot(id) {
    return this.transaction(['sessions', 'events'], 'readonly', (tx, done) => {
      // Both requests share one transaction, so an arriving sample cannot make
      // the displayed summary disagree with the exported/charted event rows.
      const snapshot = { session: null, events: [] };
      tx.objectStore('sessions').get(id).onsuccess = event => {
        snapshot.session = event.target.result ?? null;
      };
      tx.objectStore('events').index('sessionId').getAll(IDBKeyRange.only(id)).onsuccess = event => {
        snapshot.events = event.target.result.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
      };
      done(snapshot);
    });
  }

  async getSamples(id) {
    return (await this.getEvents(id)).filter(event => event.bpm !== null);
  }

  async deleteSession(id) {
    return this.transaction(['sessions', 'events'], 'readwrite', (tx, done, fail) => {
      const sessions = tx.objectStore('sessions');
      sessions.get(id).onsuccess = event => {
        if (event.target.result?.status === 'recording') { fail(new Error('請先停止紀錄，再刪除此筆資料。')); return; }
        sessions.delete(id);
        tx.objectStore('events').index('sessionId').openCursor(IDBKeyRange.only(id)).onsuccess = cursorEvent => {
          const cursor = cursorEvent.target.result;
          if (!cursor) { done(); return; }
          cursor.delete();
          cursor.continue();
        };
      };
    });
  }
}

function csvCell(value) {
  let text = String(value ?? '');
  // Excel can evaluate a quoted field; neutralize formulas even after whitespace/control characters.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function sessionCsv(session, samples) {
  const header = ['紀錄識別碼', '來源', '機台編號', '機台名稱', '裝置名稱', 'UTC時間', '經過秒數', 'BPM'];
  const rows = [header];
  for (const sample of samples) {
    if (!Number.isFinite(sample.bpm) || sample.bpm <= 0) continue;
    rows.push([
      session.id, session.source === 'demo' ? '模擬' : '藍牙', Number(session.slotId) + 1, session.machine,
      session.deviceName, new Date(sample.timestamp).toISOString(),
      ((sample.timestamp - session.startedAt) / 1000).toFixed(3), sample.bpm,
    ]);
  }
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
