import test from 'node:test';
import assert from 'node:assert/strict';
import { BleSlot } from '../assets/ble.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

class Clock {
  time = 0;
  jobs = new Map();
  sequence = 0;
  setTimeout(fn, ms) { const id = ++this.sequence; this.jobs.set(id, { at: this.time + ms, fn }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  async advance(ms) {
    const end = this.time + ms;
    await flush();
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.jobs.delete(next[0]);
      next[1].fn();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

class Events {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ target: this }); }
  count(type) { return this.listeners.get(type)?.size ?? 0; }
}

class Characteristic extends Events {
  starts = 0;
  stops = 0;
  value = null;
  async startNotifications() { this.starts++; this.onStart?.(); return this; }
  async stopNotifications() { this.stops++; return this; }
  sample(bpm, flags = 0) {
    this.value = new DataView(Uint8Array.from(flags & 1 ? [flags, bpm & 255, bpm >> 8] : [flags, bpm]).buffer);
    this.emit('characteristicvaluechanged');
  }
}

class Device extends Events {
  constructor(id) {
    super();
    this.id = id;
    this.name = `手錶 ${id}`;
    this.characteristic = new Characteristic();
    this.connectCalls = 0;
    this.disconnectCalls = 0;
    this.connectImpl = null;
    this.serviceImpl = null;
    this.gatt = {
      connected: false,
      connect: async () => {
        this.connectCalls++;
        if (this.connectImpl) await this.connectImpl();
        this.gatt.connected = true;
        return this.gatt;
      },
      disconnect: () => {
        this.disconnectCalls++;
        if (this.gatt.connected) {
          this.gatt.connected = false;
          this.emit('gattserverdisconnected');
        }
      },
      getPrimaryService: async (uuid) => {
        assert.equal(uuid, 0x180d);
        if (this.serviceImpl) await this.serviceImpl();
        return { getCharacteristic: async (characteristicUuid) => {
          assert.equal(characteristicUuid, 0x2a37);
          return this.characteristic;
        } };
      },
    };
  }
  loseConnection() { this.gatt.disconnect(); }
}

function fixture({ device = new Device('one'), registry = new Map(), clock = new Clock(), ...overrides } = {}) {
  const states = [], samples = [], terminals = [];
  const bluetooth = { requestDevice: () => Promise.resolve(device) };
  const slot = new BleSlot({ id: 0, registry, bluetooth,
    now: () => clock.time, timers: clock,
    onState: (state) => states.push(state), onSample: (sample) => samples.push(sample),
    onTerminal: (event) => terminals.push(event.reason), ...overrides });
  return { slot, device, registry, clock, states, samples, terminals, bluetooth };
}

test('requestDevice is synchronous and listener is installed before subscription starts', async () => {
  const f = fixture();
  let requested = false;
  f.bluetooth.requestDevice = (options) => {
    requested = true;
    assert.deepEqual(options, { filters: [{ services: [0x180d] }] });
    return Promise.resolve(f.device);
  };
  f.device.characteristic.onStart = () => f.device.characteristic.sample(75);
  const promise = f.slot.connect();
  assert.equal(requested, true);
  await promise;
  assert.equal(f.slot.snapshot.status, 'live');
  assert.equal(f.samples.length, 1);
  f.slot.dispose();
  assert.equal(f.device.characteristic.count('characteristicvaluechanged'), 0);
  assert.equal(f.clock.jobs.size, 0);
});

test('four devices stay isolated and cannot be assigned to a second slot', async () => {
  const registry = new Map();
  const fixtures = Array.from({ length: 4 }, (_, i) => fixture({ id: i, registry, device: new Device(`watch-${i}`) }));
  await Promise.all(fixtures.map((f) => f.slot.connect()));
  fixtures.forEach((f, i) => f.device.characteristic.sample(70 + i));
  assert.deepEqual(fixtures.map((f) => f.slot.snapshot.currentBpm), [70, 71, 72, 73]);
  assert.equal(registry.size, 4);
  const duplicate = fixture({ id: 5, registry, device: fixtures[0].device });
  assert.equal(await duplicate.slot.connect(), false);
  assert.match(duplicate.slot.snapshot.error, /已綁定/);
  assert.equal(fixtures[0].device.gatt.connected, true);
  assert.equal(fixtures[0].device.connectCalls, 1);
  fixtures.forEach((f) => f.slot.dispose());
  duplicate.slot.dispose();
  assert.equal(registry.size, 0);
});

test('zero, lost contact and malformed packets are not recorded; freshness expires', async () => {
  const f = fixture();
  await f.slot.connect();
  assert.equal(f.slot.snapshot.status, 'waiting');
  f.device.characteristic.sample(75);
  await f.clock.advance(9999);
  f.slot.tick();
  assert.equal(f.slot.snapshot.status, 'live');
  await f.clock.advance(1);
  f.slot.tick();
  assert.equal(f.slot.snapshot.status, 'stale');
  assert.equal(f.slot.snapshot.currentBpm, null);
  f.device.characteristic.sample(80, 4);
  assert.equal(f.slot.snapshot.status, 'no-contact');
  f.device.characteristic.sample(0);
  assert.equal(f.slot.snapshot.currentBpm, null);
  f.device.characteristic.value = new DataView(new ArrayBuffer(0));
  f.device.characteristic.emit('characteristicvaluechanged');
  assert.equal(f.samples.length, 1);
  f.device.characteristic.sample(260, 7);
  assert.equal(f.slot.snapshot.currentBpm, 260);
  assert.equal(f.samples.length, 2);
  f.slot.dispose();
});

test('initial connection failure cleans GATT and releases the reservation', async () => {
  const f = fixture();
  f.device.serviceImpl = () => { throw new Error('service absent'); };
  assert.equal(await f.slot.connect(), false);
  assert.equal(f.device.gatt.connected, false);
  assert.equal(f.registry.size, 0);
  assert.equal(f.device.count('gattserverdisconnected'), 0);
  assert.equal(f.device.characteristic.count('characteristicvaluechanged'), 0);
  assert.deepEqual(f.terminals, ['connect-failed']);
  assert.equal(f.clock.jobs.size, 0);
});

test('chooser cancellation is quiet and a late choice after manual cancel is ignored', async () => {
  const f = fixture();
  f.bluetooth.requestDevice = () => Promise.reject(Object.assign(new Error('cancel'), { name: 'NotFoundError' }));
  await f.slot.connect();
  assert.equal(f.slot.snapshot.status, 'idle');
  assert.equal(f.slot.snapshot.error, null);
  assert.deepEqual(f.terminals, []);
  const choice = deferred();
  f.bluetooth.requestDevice = () => choice.promise;
  const pending = f.slot.connect();
  f.slot.disconnect();
  choice.resolve(f.device);
  await pending;
  assert.equal(f.device.connectCalls, 0);
  assert.equal(f.registry.size, 0);
});

test('reconnection preserves the reservation and installs only one notification listener', async () => {
  const f = fixture();
  await f.slot.connect();
  for (let i = 0; i < 10; i++) {
    f.device.loseConnection();
    assert.equal(f.slot.snapshot.status, 'reconnecting');
    assert.equal(f.registry.get(f.device.id), f.slot);
    await f.clock.advance(1000);
    assert.equal(f.slot.snapshot.status, 'waiting');
    assert.equal(f.device.characteristic.count('characteristicvaluechanged'), 1);
    f.device.characteristic.sample(80);
  }
  assert.equal(f.samples.length, 10);
  assert.deepEqual(f.terminals, []);
  f.slot.disconnect();
  assert.deepEqual(f.terminals, ['manual']);
  assert.equal(f.registry.size, 0);
});

test('five retries use 1/2/4/8/16 seconds; exhaustion terminates exactly once', async () => {
  const f = fixture();
  await f.slot.connect();
  const attempts = [];
  f.device.connectImpl = () => { attempts.push(f.clock.time); throw new Error('out of range'); };
  f.device.loseConnection();
  await f.clock.advance(31000);
  assert.deepEqual(attempts, [1000, 3000, 7000, 15000, 31000]);
  assert.equal(f.slot.snapshot.status, 'disconnected');
  assert.deepEqual(f.terminals, ['retries-exhausted']);
  assert.equal(f.registry.size, 0);
  f.slot.disconnect();
  assert.deepEqual(f.terminals, ['retries-exhausted']);
});

test('manual disconnect cancels retry timers and old notifications', async () => {
  const f = fixture();
  await f.slot.connect();
  f.device.loseConnection();
  f.slot.disconnect();
  await f.clock.advance(60000);
  f.device.characteristic.sample(99);
  assert.equal(f.device.connectCalls, 1);
  assert.equal(f.samples.length, 0);
  assert.equal(f.clock.jobs.size, 0);
  assert.equal(f.slot.snapshot.status, 'disconnected');
});

test('pending notification shutdown finishes before a replacement subscription starts', async () => {
  const f = fixture();
  await f.slot.connect();
  const shutdown = deferred();
  f.device.characteristic.stopNotifications = () => shutdown.promise;
  f.device.loseConnection();
  await f.clock.advance(1000);
  assert.equal(f.slot.snapshot.status, 'reconnecting');
  assert.equal(f.device.connectCalls, 1);
  assert.equal(f.device.characteristic.starts, 1);
  shutdown.resolve();
  await flush();
  assert.equal(f.device.connectCalls, 2);
  assert.equal(f.device.characteristic.starts, 2);
  assert.equal(f.slot.snapshot.status, 'waiting');
  f.device.characteristic.sample(81);
  assert.equal(f.samples.length, 1);
  f.slot.dispose();
});

test('a timed-out reconnect can settle late before a later retry succeeds without duplicate samples', async () => {
  const f = fixture();
  await f.slot.connect();
  const reconnect = deferred();
  f.device.connectImpl = () => reconnect.promise;
  f.device.loseConnection();
  await f.clock.advance(16000); // First retry at 1 s; its setup times out at 16 s.
  assert.equal(f.slot.snapshot.status, 'reconnecting');
  assert.equal(f.slot.snapshot.attempt, 2);
  assert.equal(f.device.connectCalls, 2);
  f.device.connectImpl = null;
  await f.clock.advance(2000); // Second retry waits for the old browser operation.
  assert.equal(f.device.connectCalls, 2);
  reconnect.resolve();
  await flush();
  assert.equal(f.device.connectCalls, 3);
  assert.equal(f.slot.snapshot.status, 'waiting');
  assert.equal(f.device.gatt.connected, true);
  assert.equal(f.device.characteristic.count('characteristicvaluechanged'), 1);
  f.device.characteristic.sample(88);
  assert.equal(f.samples.length, 1);
  assert.deepEqual(f.terminals, []);
  f.slot.dispose();
});

test('15-second setup timeout cleans a late connection before another slot can use it', async () => {
  const device = new Device('late');
  const clock = new Clock();
  const registry = new Map();
  const connection = deferred();
  device.connectImpl = () => connection.promise;
  const a = fixture({ device, clock, registry });
  const pending = a.slot.connect();
  await flush();
  await clock.advance(15000);
  assert.equal(await pending, false);
  assert.equal(a.slot.snapshot.status, 'error');
  assert.equal(registry.size, 0);
  device.connectImpl = null;
  const b = fixture({ device, clock, registry, id: 1 });
  const next = b.slot.connect();
  await flush();
  assert.equal(device.connectCalls, 1);
  connection.resolve();
  assert.equal(await next, true);
  assert.equal(device.connectCalls, 2);
  assert.equal(device.gatt.connected, true);
  assert.equal(a.slot.snapshot.status, 'error');
  assert.equal(b.slot.snapshot.status, 'waiting');
  device.characteristic.sample(100);
  assert.equal(a.samples.length, 0);
  assert.equal(b.samples.length, 1);
  b.slot.dispose();
});

test('late startNotifications cannot revive a manually disconnected slot', async () => {
  const f = fixture();
  const subscription = deferred();
  f.device.characteristic.startNotifications = () => subscription.promise;
  const pending = f.slot.connect();
  await flush();
  f.slot.disconnect();
  assert.equal(await pending, false);
  subscription.resolve(f.device.characteristic);
  await flush();
  f.device.characteristic.sample(70);
  assert.equal(f.slot.snapshot.status, 'disconnected');
  assert.equal(f.device.gatt.connected, false);
  assert.equal(f.samples.length, 0);
  assert.equal(f.device.characteristic.count('characteristicvaluechanged'), 0);
  assert.deepEqual(f.terminals, ['manual']);
});

test('four simulated BLE streams deliver exactly 28800 readings over two equivalent hours', async () => {
  const clock = new Clock();
  const registry = new Map();
  const slots = Array.from({ length: 4 }, (_, id) => fixture({ id, clock, registry, device: new Device(`long-${id}`) }));
  await Promise.all(slots.map((f) => f.slot.connect()));
  for (let second = 0; second < 7200; second++) {
    clock.time = second * 1000;
    for (const [id, f] of slots.entries()) {
      f.device.characteristic.sample(65 + id + second % 90);
      f.slot.tick();
    }
  }
  assert.deepEqual(slots.map((f) => f.samples.length), [7200, 7200, 7200, 7200]);
  assert.ok(slots.every((f) => f.device.characteristic.count('characteristicvaluechanged') === 1));
  slots.forEach((f) => f.slot.dispose());
  assert.equal(registry.size, 0);
  assert.equal(clock.jobs.size, 0);
});
