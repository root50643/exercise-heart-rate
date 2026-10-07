import { parseHeartRateMeasurement } from './core.js';

// Serialise unfinished browser operations per physical device, even after a slot
// releases it. A late connection cannot disconnect a newer slot's healthy link.
const transportQueues = new WeakMap();
const noop = () => {};
const cancelledError = () => Object.assign(new Error('連線已取消'), { code: 'CANCELLED' });

function friendlyError(error) {
  if (error?.code === 'DUPLICATE') return '這支裝置已綁定其他機台，請選擇另一支。';
  if (error?.code === 'TIMEOUT') return '藍牙連線逾時，請確認裝置已開啟心率廣播且在附近。';
  if (error?.name === 'SecurityError') return '請使用 localhost 或 HTTPS，並允許瀏覽器使用藍牙。';
  if (error?.name === 'NotSupportedError') return '此裝置或瀏覽器不支援標準 BLE 心率服務。';
  return '無法建立心率連線。請確認裝置正在廣播心率，且未被其他應用程式占用。';
}

export class BleSlot {
  constructor({ id, registry = new Map(), bluetooth = globalThis.navigator?.bluetooth,
    onState = noop, onSample = noop, onTerminal = noop,
    now = () => Date.now(), timers = globalThis,
    retryDelays = [1000, 2000, 4000, 8000, 16000], connectionTimeoutMs = 15000,
    staleAfterMs = 10000 } = {}) {
    Object.assign(this, { id, registry, bluetooth, onState, onSample, onTerminal,
      now, timers, retryDelays, connectionTimeoutMs, staleAfterMs });
    this._state = { status: 'idle', deviceName: '', deviceId: null,
      currentBpm: null, lastValidAt: null, error: null, attempt: 0 };
    this._epoch = 0;
    this._device = null;
    this._attempt = null;
    this._sleepCancel = null;
    this._linkReady = false;
    this._disposed = false;
    this._terminal = true;
    this._connectedAt = null;
    this._disconnectListener = null;
    if (!transportQueues.has(registry)) transportQueues.set(registry, new Map());
    this._queues = transportQueues.get(registry);
  }

  get snapshot() { return { ...this._state }; }
  _set(patch) { Object.assign(this._state, patch); this.onState(this.snapshot); }
  _current(epoch) { return !this._disposed && epoch === this._epoch; }

  // Keep requestDevice in this synchronous call stack: browser gesture permission
  // would be lost if storage, cleanup, or any other promise were awaited first.
  connect() {
    if (this._disposed) return Promise.resolve(false);
    if (['selecting', 'connecting', 'reconnecting', 'waiting', 'live', 'no-contact', 'stale'].includes(this._state.status)) {
      return this._connectPromise ?? Promise.resolve(false);
    }
    const epoch = ++this._epoch;
    this._terminal = false;
    this._set({ status: 'selecting', error: null, currentBpm: null, lastValidAt: null, attempt: 0 });
    let chooser;
    try {
      if (!this.bluetooth?.requestDevice) throw Object.assign(new Error('Web Bluetooth unavailable'), { name: 'NotSupportedError' });
      chooser = this.bluetooth.requestDevice({ filters: [{ services: [0x180d] }] });
    } catch (error) {
      this._fail(epoch, error, 'connect-failed');
      return Promise.resolve(false);
    }
    this._connectPromise = Promise.resolve(chooser).then(async (device) => {
      if (!this._current(epoch)) return false;
      const owner = this.registry.get(device.id);
      if (owner && owner !== this) throw Object.assign(new Error('Duplicate device'), { code: 'DUPLICATE' });
      if (!device.gatt) throw Object.assign(new Error('GATT unavailable'), { name: 'NotSupportedError' });
      this.registry.set(device.id, this);
      this._device = device;
      this._disconnectListener = () => this._unexpectedDisconnect(epoch);
      device.addEventListener('gattserverdisconnected', this._disconnectListener);
      this._set({ status: 'connecting', deviceId: device.id, deviceName: device.name || '未命名心率裝置' });
      await this._setup(epoch);
      return this._current(epoch);
    }).catch((error) => {
      if (!this._current(epoch)) return false;
      if (error?.name === 'NotFoundError' && !this._device) {
        this._terminal = true;
        this._set({ status: 'idle', error: null, currentBpm: null });
      } else this._fail(epoch, error, 'connect-failed');
      return false;
    });
    return this._connectPromise;
  }

  async _setup(epoch) {
    const device = this._device;
    const attempt = { epoch, device, cancelled: false, started: false, characteristic: null, listener: null };
    this._attempt = attempt;
    const check = () => {
      if (attempt.cancelled || !this._current(epoch)) throw cancelledError();
    };
    const previous = this._queues.get(device.id) ?? Promise.resolve();
    // The deadline includes waiting for a previous uncancellable browser request.
    const work = previous.catch(noop).then(async () => {
      check();
      attempt.started = true;
      try {
        const server = await device.gatt.connect();
        check();
        const service = await server.getPrimaryService(0x180d);
        check();
        const characteristic = await service.getCharacteristic(0x2a37);
        attempt.characteristic = characteristic;
        check();
        attempt.listener = (event) => {
          if (!attempt.cancelled && this._current(epoch)) this._measurement(event.target.value);
        };
        characteristic.addEventListener('characteristicvaluechanged', attempt.listener);
        await characteristic.startNotifications();
        check();
        if (!device.gatt.connected) throw new Error('GATT disconnected during setup');
        this._linkReady = true;
        this._connectedAt = this.now();
        const status = ['live', 'no-contact'].includes(this._state.status) ? this._state.status : 'waiting';
        this._set({ status, error: null, attempt: 0 });
      } catch (error) {
        await this._cleanupAttempt(attempt);
        throw error;
      }
    });
    const tail = work.catch(noop);
    this._holdTransport(device.id, tail);
    let timer;
    const deadline = new Promise((_, reject) => {
      attempt.cancelWait = () => reject(cancelledError());
      timer = this.timers.setTimeout(() => {
        this._cleanupAttempt(attempt);
        reject(Object.assign(new Error('GATT timeout'), { code: 'TIMEOUT' }));
      }, this.connectionTimeoutMs);
    });
    try { await Promise.race([work, deadline]); }
    finally { this.timers.clearTimeout(timer); }
  }

  _holdTransport(id, tail) {
    this._queues.set(id, tail);
    void tail.then(() => {
      if (this._queues.get(id) === tail) this._queues.delete(id);
    });
  }

  _cleanupAttempt(attempt) {
    if (!attempt) return Promise.resolve();
    attempt.cancelled = true;
    if (this._attempt === attempt) this._linkReady = false;
    if (attempt.characteristic && attempt.listener) {
      attempt.characteristic.removeEventListener('characteristicvaluechanged', attempt.listener);
      attempt.listener = null;
    }
    if (attempt.characteristic) {
      try {
        const stop = Promise.resolve(attempt.characteristic.stopNotifications()).catch(noop);
        // Await shutdown before a later startNotifications on the same device.
        // Keep this promise separate from the queue, because setup's own catch
        // may await it while its work promise is still part of that queue.
        attempt.cleanup = Promise.all([attempt.cleanup, stop]).then(noop);
        const queued = this._queues.get(attempt.device.id) ?? Promise.resolve();
        this._holdTransport(attempt.device.id, Promise.all([queued, attempt.cleanup]).then(noop));
      } catch { /* Already disconnected. */ }
    }
    if (attempt.started) {
      try { attempt.device.gatt.disconnect(); } catch { /* Browser may have already closed GATT. */ }
    }
    return attempt.cleanup ?? Promise.resolve();
  }

  _measurement(value) {
    let reading;
    try { reading = parseHeartRateMeasurement(value); }
    catch {
      this._set({ currentBpm: null, status: 'waiting', error: '收到不完整心率封包，等待下一筆有效資料。' });
      return;
    }
    if (reading.contact === false) {
      this._set({ currentBpm: null, status: 'no-contact', error: null });
      return;
    }
    if (reading.bpm === 0) {
      this._set({ currentBpm: null, status: 'waiting', error: null });
      return;
    }
    const timestamp = this.now();
    this._set({ status: 'live', currentBpm: reading.bpm, lastValidAt: timestamp, error: null });
    this.onSample({ timestamp, ...reading });
  }

  tick(now = this.now()) {
    if (!this._linkReady || !['waiting', 'live', 'stale'].includes(this._state.status)) return;
    const since = Math.max(this._state.lastValidAt ?? -Infinity, this._connectedAt ?? now);
    if (now - since >= this.staleAfterMs && this._state.status !== 'stale') {
      this._set({ status: 'stale', currentBpm: null });
    }
  }

  _unexpectedDisconnect(epoch) {
    if (!this._current(epoch) || !this._linkReady) return;
    this._cleanupAttempt(this._attempt);
    this._set({ status: 'reconnecting', currentBpm: null, error: null, attempt: 0 });
    void this._reconnect(epoch);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this._sleepCancel = null;
        resolve(true);
      }, ms);
      this._sleepCancel = () => {
        this.timers.clearTimeout(timer);
        this._sleepCancel = null;
        resolve(false);
      };
    });
  }

  async _reconnect(epoch) {
    let lastError;
    for (let i = 0; i < this.retryDelays.length; i++) {
      if (!this._current(epoch)) return;
      this._set({ status: 'reconnecting', attempt: i + 1 });
      if (!await this._sleep(this.retryDelays[i]) || !this._current(epoch)) return;
      try {
        await this._setup(epoch);
        return;
      } catch (error) {
        lastError = error;
        if (!this._current(epoch)) return;
      }
    }
    this._fail(epoch, lastError, 'retries-exhausted');
  }

  _release() {
    this._sleepCancel?.();
    this._cleanupAttempt(this._attempt);
    this._attempt?.cancelWait?.();
    this._attempt = null;
    if (this._device) {
      if (this._disconnectListener) this._device.removeEventListener('gattserverdisconnected', this._disconnectListener);
      if (this.registry.get(this._device.id) === this) this.registry.delete(this._device.id);
    }
    this._device = null;
    this._disconnectListener = null;
    this._linkReady = false;
    this._connectedAt = null;
  }

  _notifyTerminal(reason) {
    if (this._terminal) return;
    this._terminal = true;
    this.onTerminal({ reason });
  }

  _fail(epoch, error, reason) {
    if (!this._current(epoch)) return;
    ++this._epoch;
    this._release();
    this._set({ status: reason === 'retries-exhausted' ? 'disconnected' : 'error',
      currentBpm: null, deviceId: null, attempt: 0,
      error: reason === 'retries-exhausted' ? '自動重連已失敗，紀錄已中斷。請重新連線。' : friendlyError(error) });
    this._notifyTerminal(reason);
  }

  disconnect(reason = 'manual') {
    ++this._epoch;
    this._release();
    this._set({ status: this._terminal && this._state.status === 'idle' ? 'idle' : 'disconnected',
      deviceId: null, currentBpm: null, error: null, attempt: 0 });
    this._notifyTerminal(reason);
  }

  dispose() {
    if (this._disposed) return;
    this.disconnect('manual');
    this._disposed = true;
  }
}
