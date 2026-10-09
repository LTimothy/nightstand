import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after, mock } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, appendFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import cbor from 'cbor';

import type { DeviceStatus } from '../routes/deviceStatus/deviceStatusSchema.js';

// Synthetic RAW records only.
const frameRecord = (seq: number, data: Buffer): Buffer => cbor.encode({ seq, data });

// Same isolated DATA_FOLDER pattern as frankenMonitor.test.ts, plus a RAW
// directory of this test's own.
const dataFolder = mkdtempSync(path.join(tmpdir(), 'free-sleep-buttons-'));
mkdirSync(path.join(dataFolder, 'lowdb'));
const rawDir = mkdtempSync(path.join(tmpdir(), 'free-sleep-raw-'));
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
process.env.POD_RAW_DIR = rawDir;

let readTargets = { left: 82, right: 82 };
let updates: Array<Partial<DeviceStatus>> = [];
let updateRejectsWith: Error | null = null;
let readRejectsWith: Error | null = null;
let afterRead: (() => void) | null = null;
let afterWrite: (() => void) | null = null;
let writeOptions: Array<import('./frankenServer.js').CommandOptions> = [];
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
  namedExports: {
    updateDeviceStatus: async (status: Partial<DeviceStatus>, options: import('./frankenServer.js').CommandOptions = {}) => {
      writeOptions.push(options);
      updates.push(status);
      if (updateRejectsWith) throw updateRejectsWith;
      if (options.notAfter !== undefined && Date.now() > options.notAfter) throw new Error('click expired');
      await Promise.resolve();
      for (const side of ['left', 'right'] as const) {
        const target = status[side]?.targetTemperatureF;
        if (target !== undefined) readTargets[side] = target;
      }
      afterWrite?.();
    },
  },
});

let manualChanges: string[] = [];
mock.module(new URL('../jobs/scheduleOverride.js', import.meta.url).href, {
  namedExports: {
    markManualTempChange: async (side: string) => { manualChanges.push(side); },
  },
});

let readCalls: string[] = [];
const readStatus = async () => {
  readCalls.push('read');
  if (readRejectsWith) throw readRejectsWith;
  const status = {
    left: { targetTemperatureF: readTargets.left },
    right: { targetTemperatureF: readTargets.right },
  };
  afterRead?.();
  return status;
};
mock.module(new URL('./frankenServer.js', import.meta.url).href, {
  namedExports: {
    getDeviceStatusCoalesced: readStatus,
    connectFrankenWithin: async () => ({ getDeviceStatus: readStatus }),
    connectFranken: async () => ({}),
    FrankenCommandTimeoutError: class extends Error {},
  },
});

let ButtonMonitor: typeof import('./buttonMonitor.js')['ButtonMonitor'];
let settingsDB: typeof import('../db/settings.js')['default'];
let serverStatus: typeof import('../serverStatus.js')['default'];
before(async () => {
  ({ ButtonMonitor } = await import('./buttonMonitor.js'));
  ({ default: settingsDB } = await import('../db/settings.js'));
  ({ default: serverStatus } = await import('../serverStatus.js'));
});

const logRecord = (msg: string, seq = 1, ts = Date.now() / 1000): Buffer =>
  frameRecord(seq, cbor.encode({ type: 'log', ts, level: 'info', msg, seq }));

function click(sideTag: 'R' | 'L', code: number, seq = 1): Buffer {
  return Buffer.concat([
    logRecord(`[tca8418${sideTag}] gpi press ${code}`, seq),
    logRecord(`[tca8418${sideTag}] gpi release ${code}`, seq),
    logRecord('[TTC] ignoring 1 short clicks', seq),
  ]);
}

// The firmware batches several log records into one chunk (about 1.6 KB seen
// live), most of them unrelated lines.
function batchedClick(sideTag: 'R' | 'L', code: number, seq = 1): Buffer {
  const filler = 'x'.repeat(120);
  const now = Date.now() / 1000;
  return frameRecord(seq, Buffer.concat([
    cbor.encode({ type: 'log', ts: now, level: 'debug', msg: `AsioTcpClient.h:63 tryConnect|[asiotcp] ${filler}` }),
    cbor.encode({
      type: 'log', ts: now, level: 'debug', msg: `Sensor.cpp:608 handleCommand|[sensor] -> FW: 1 [tca8418${sideTag}] gpi press ${code}`,
    }),
    cbor.encode({
      type: 'log', ts: now, level: 'debug', msg: `Sensor.cpp:608 handleCommand|[sensor] -> FW: 2 [tca8418${sideTag}] gpi release ${code}`,
    }),
    cbor.encode({ type: 'log', ts: now, msg: '[TTC] ignoring 1 short clicks' }),
    ...Array.from({ length: 8 }, (_, index) =>
      cbor.encode({ type: 'log', ts: now, level: 'debug', msg: `Thermostat.cpp:99 tick|[therm] ${filler} ${index}` })),
  ]));
}

// Drives the private poll directly instead of waiting on the interval.
type Internals = {
  poll(): Promise<void>;
  dispatch(event: import('./buttonEvents.js').ButtonEvent): Promise<void>;
  tail: { carry: Buffer } | null;
};

function writeRaw(name: string, buffer: Buffer, mtimeSec: number): string {
  const full = path.join(rawDir, name);
  writeFileSync(full, buffer);
  utimesSync(full, mtimeSec, mtimeSec);
  return full;
}

function appendRaw(full: string, buffer: Buffer, mtimeSec: number): void {
  appendFileSync(full, buffer);
  utimesSync(full, mtimeSec, mtimeSec);
}

const leftTargets = () => updates.map(update => update.left?.targetTemperatureF).filter(target => target !== undefined);
const rightTargets = () => updates.map(update => update.right?.targetTemperatureF).filter(target => target !== undefined);

describe('ButtonMonitor', () => {
  let monitor: Internals;

  beforeEach(async () => {
    updates = []; manualChanges = []; readCalls = [];
    updateRejectsWith = null;
    readRejectsWith = null; afterRead = null; afterWrite = null; writeOptions = [];
    readTargets = { left: 82, right: 82 };
    for (const file of readdirSync(rawDir)) rmSync(path.join(rawDir, file));
    await settingsDB.read();
    settingsDB.data.features.coverButtons = true;
    await settingsDB.write();

    monitor = new ButtonMonitor() as unknown as Internals;
    // The first poll reads nothing: it only finds where the newest file ends.
    await monitor.poll();
  });

  it('drops an emitted click that expired before dispatch', async () => {
    await monitor.dispatch({ side: 'right', button: 'top', kind: 'click', at: Date.now() - 30_001 });
    assert.deepEqual(updates, []);
    assert.deepEqual(readCalls, []);
  });

  it('bounds a write by the timestamp of the ignoring line', async () => {
    const at = Date.now();
    writeRaw('001.RAW', Buffer.concat([
      logRecord('[tca8418R] gpi press 97', 1, at / 1000),
      logRecord('[tca8418R] gpi release 97', 1, at / 1000),
      logRecord('[TTC] ignoring 1 short clicks', 1, (at + 1) / 1000),
    ]), at / 1000);
    await monitor.poll();
    assert.deepEqual(writeOptions, [{ notAfter: at + 30_001 }]);
  });

  it('drops later clicks once a preceding write has consumed their time', async () => {
    const at = Date.now();
    const clock = mock.method(Date, 'now', () => at);
    try {
      afterWrite = () => { clock.mock.mockImplementation(() => at + 30_001); };
      writeRaw('001.RAW', Buffer.concat([click('R', 97), click('R', 97)]), at / 1000);
      await monitor.poll();
      assert.deepEqual(rightTargets(), [83]);
    } finally { clock.mock.restore(); }
  });

  for (const invalid of [false, true]) {
    it(`reports a ${invalid ? 'missing target' : 'failed status read'} as failed and resumes polling`, async () => {
      if (invalid) readTargets.right = Number.NaN;
      else readRejectsWith = new Error('read failed');
      const full = writeRaw('001.RAW', click('R', 97), Date.now() / 1000);
      await monitor.poll();
      assert.deepEqual(updates, []);
      assert.equal(serverStatus.status.buttonMonitor.status, 'failed');
      assert.match(serverStatus.status.buttonMonitor.message, invalid ? /no target/ : /read failed/);
      readRejectsWith = null; readTargets.right = 82;
      appendRaw(full, click('R', 97), Date.now() / 1000);
      await monitor.poll();
      assert.deepEqual(rightTargets(), [83]);
      assert.equal(serverStatus.status.buttonMonitor.status, 'healthy');
    });
  }

  it('does not send a click that expires during the status read', async () => {
    const at = Date.now();
    const clock = mock.method(Date, 'now', () => at);
    try {
      afterRead = () => { clock.mock.mockImplementation(() => at + 30_001); };
      writeRaw('001.RAW', click('R', 97), at / 1000);
      await monitor.poll();
      assert.deepEqual(rightTargets(), []);
      assert.deepEqual(manualChanges, []);
    } finally { clock.mock.restore(); }
  });

  it('discards the tail and pending clicks while off and resumes at the newest file end', async () => {
    const full = writeRaw('001.RAW', Buffer.concat([
      logRecord('[tca8418R] gpi press 97'), logRecord('[tca8418R] gpi release 97'),
      logRecord('[tca8418R] gpi press 99'),
    ]), Date.now() / 1000);
    await monitor.poll();
    settingsDB.data.features.coverButtons = false;
    await settingsDB.write();
    await monitor.poll();
    appendRaw(full, click('L', 99), Date.now() / 1000);
    const newest = writeRaw('002.RAW', click('L', 99), Date.now() / 1000 + 0.01);
    settingsDB.data.features.coverButtons = true;
    await settingsDB.write();
    await monitor.poll();
    appendRaw(newest, Buffer.concat([
      logRecord('[tca8418R] gpi release 99'), logRecord('[TTC] ignoring 2 short clicks'),
    ]), Date.now() / 1000 + 0.01);
    await monitor.poll();
    assert.deepEqual(updates, []);
    appendRaw(newest, click('R', 97), Date.now() / 1000 + 0.01);
    await monitor.poll();
    assert.deepEqual(rightTargets(), [83]);
  });

  it('ignores a click made while off even if firmware logs it after reenabling', async () => {
    const at = Date.now() + 10;
    const clock = mock.method(Date, 'now', () => at);
    try {
      const full = writeRaw('001.RAW', Buffer.alloc(0), at / 1000);
      await monitor.poll();
      settingsDB.data.features.coverButtons = false;
      await settingsDB.write();
      await monitor.poll();
      const delayed = click('R', 97);
      clock.mock.mockImplementation(() => at + 100);
      settingsDB.data.features.coverButtons = true;
      await settingsDB.write();
      await monitor.poll();
      appendRaw(full, delayed, (at + 100) / 1000);
      await monitor.poll();
      assert.deepEqual(updates, []);
      appendRaw(full, click('R', 97), (at + 100) / 1000);
      await monitor.poll();
      assert.deepEqual(rightTargets(), [83]);
    } finally { clock.mock.restore(); }
  });

  it('steps the right side up by 1 F on an ignored top click', async () => {
    writeRaw('001.RAW', click('R', 97), Date.now() / 1000);
    await monitor.poll();

    assert.deepEqual(rightTargets(), [83]);
    assert.deepEqual(manualChanges, ['right']);
  });

  it('steps the left side down on a bottom click', async () => {
    writeRaw('001.RAW', click('L', 99), Date.now() / 1000);
    await monitor.poll();

    assert.deepEqual(leftTargets(), [81]);
  });

  it('finds a click inside a batched chunk of unrelated log lines', async () => {
    const chunk = batchedClick('R', 97);
    assert.ok(chunk.length > 512);
    writeRaw('001.RAW', chunk, Date.now() / 1000);
    await monitor.poll();

    assert.deepEqual(rightTargets(), [83]);
  });

  it('reads each target after the previous write resolves', async () => {
    writeRaw('001.RAW', Buffer.concat([click('R', 97, 1), click('R', 97, 2), click('R', 97, 3)]), Date.now() / 1000);
    await monitor.poll();

    assert.deepEqual(rightTargets(), [83, 84, 85]);
  });

  it('keeps the target within 55 to 110 F', async () => {
    readTargets.right = 110;
    writeRaw('001.RAW', click('R', 97), Date.now() / 1000);
    await monitor.poll();

    assert.deepEqual(rightTargets(), [110]);
  });

  it('does nothing for a logo click or keypad noise', async () => {
    writeRaw('001.RAW', Buffer.concat([
      click('L', 98), click('R', 105),
      logRecord('[tca8418R] invalid gpi->row 105->255'),
      logRecord('[tca8418R] gpi press 127'),
      logRecord('[TTC] ignoring 1 short clicks'),
    ]), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(updates, []);
    assert.deepEqual(manualChanges, []);
  });

  for (const encFirst of [true, false]) {
    it(`does not double step a Pod 5 click (encoding first: ${encFirst})`, async () => {
      const handled = [
        '[TTC] right top button clicked 1 times',
        '[buttons] enc {id:0,clicks:1}',
      ];
      if (encFirst) handled.reverse();
      writeRaw('001.RAW', Buffer.concat([
        logRecord('[tca8418R] gpi press 97'),
        logRecord('[tca8418R] gpi release 97'),
        ...handled.map(message => logRecord(message)),
        logRecord('[buttons] sending 4 bytes incl lsp cmd byte'),
        logRecord('[thermostat] on | on'),
        logRecord('[thermostat] temp_up right -24->-14'),
        logRecord('[TTC] ignoring 1 short clicks'),
      ]), Date.now() / 1000);
      await monitor.poll();
      assert.deepEqual(updates, []);
      assert.deepEqual(readCalls, []);
    });
  }

  it('applies two ignored clicks in order using fresh targets', async () => {
    writeRaw('001.RAW', Buffer.concat([
      logRecord('[tca8418R] gpi press 97'), logRecord('[tca8418R] gpi release 97'),
      logRecord('[tca8418R] gpi press 99'), logRecord('[tca8418R] gpi release 99'),
      logRecord('[TTC] ignoring 2 short clicks'),
    ]), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(rightTargets(), [83, 82]);
    assert.equal(readCalls.length, 2);
  });

  it('uses an external target change between polls', async () => {
    const full = writeRaw('001.RAW', click('R', 97), Date.now() / 1000);
    await monitor.poll();
    readTargets.right = 90;
    appendRaw(full, click('R', 99), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(rightTargets(), [83, 89]);
  });

  it('leaves a hold to the firmware', async () => {
    writeRaw('001.RAW', Buffer.concat([
      logRecord('[tca8418R] gpi press 97', 1),
      logRecord('[buttons] long press top: 500ms', 1),
      logRecord('[tca8418R] gpi release 97', 1),
    ]), Date.now() / 1000);
    await monitor.poll();

    assert.deepEqual(updates, []);
  });

  it('does nothing while coverButtons is off, and says so', async () => {
    settingsDB.data.features.coverButtons = false;
    await settingsDB.write();
    writeRaw('001.RAW', click('R', 97), Date.now() / 1000);
    const open = mock.method((await import('node:fs/promises')).default, 'open');
    try {
      await monitor.poll();
      assert.equal(open.mock.callCount(), 0);
    } finally { open.mock.restore(); }

    assert.deepEqual(updates, []);
    assert.equal(serverStatus.status.buttonMonitor.status, 'healthy');
    assert.match(serverStatus.status.buttonMonitor.message, /Off in Settings/);
  });

  it('reports a missing or stale RAW file and recovers on fresh data', async () => {
    assert.equal(serverStatus.status.buttonMonitor.status, 'failed');
    assert.match(serverStatus.status.buttonMonitor.message, /No RAW files/);
    const payload = frameRecord(1, cbor.encode({ type: 'frzHealth', ts: Date.now() / 1000 }));
    const full = writeRaw('001.RAW', payload, Date.now() / 1000 - 30);
    await monitor.poll();
    assert.equal(serverStatus.status.buttonMonitor.status, 'failed');
    assert.match(serverStatus.status.buttonMonitor.message, /not being written/);
    appendRaw(full, payload, Date.now() / 1000);
    await monitor.poll();
    assert.equal(serverStatus.status.buttonMonitor.status, 'healthy');
  });

  it('does not replay presses already in the file when it starts', async () => {
    const full = writeRaw('001.RAW', click('R', 97), Date.now() / 1000);
    const restarted = new ButtonMonitor() as unknown as Internals;
    await restarted.poll();
    assert.deepEqual(updates, []);

    appendRaw(full, click('R', 99, 2), Date.now() / 1000);
    await restarted.poll();
    assert.deepEqual(rightTargets(), [81]);
  });

  it('ignores a press older than 30 seconds', async () => {
    writeRaw('001.RAW', Buffer.concat([
      logRecord('[tca8418R] gpi press 97', 1, Date.now() / 1000 - 60),
      logRecord('[tca8418R] gpi release 97', 1, Date.now() / 1000 - 60),
    ]), Date.now() / 1000);
    await monitor.poll();

    assert.deepEqual(updates, []);
  });

  it('reads only what was appended since the last poll', async () => {
    const full = writeRaw('001.RAW', click('R', 97, 1), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(rightTargets(), [83]);

    appendRaw(full, click('R', 99, 2), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(rightTargets(), [83, 82]);
  });

  it('follows the firmware to a new file and reads it from the start', async () => {
    writeRaw('001.RAW', click('R', 97, 1), Date.now() / 1000 - 5);
    await monitor.poll();
    assert.deepEqual(rightTargets(), [83]);

    writeRaw('002.RAW', click('L', 99, 1), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(leftTargets(), [81]);
  });

  it('never tails SEQNO.RAW', async () => {
    writeRaw('001.RAW', click('R', 97, 1), Date.now() / 1000);
    writeRaw('SEQNO.RAW', Buffer.from([1, 2, 3, 4]), Date.now() / 1000 + 5);
    await monitor.poll();

    assert.deepEqual(rightTargets(), [83]);
  });

  it('resyncs past a stray byte and reads the records after it', async () => {
    writeRaw('001.RAW', Buffer.concat([Buffer.from([0xff, 0xff, 0, 0]), click('R', 97)]), Date.now() / 1000);
    await monitor.poll();

    assert.deepEqual(rightTargets(), [83]);
  });

  it('reads a record cut off at the end of one poll once the rest arrives', async () => {
    const whole = click('R', 97);
    const full = writeRaw('001.RAW', whole.subarray(0, whole.length - 7), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(updates, []);

    appendRaw(full, whole.subarray(whole.length - 7), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(rightTargets(), [83]);
  });

  it('finishes the old file before switching to a newer file', async () => {
    const full = writeRaw('001.RAW', Buffer.alloc(0), Date.now() / 1000 - 5);
    await monitor.poll();
    appendRaw(full, Buffer.concat([Buffer.alloc((1 << 20) + 32), logRecord('[tca8418L] gpi press 99')]), Date.now() / 1000 - 1);
    writeRaw('002.RAW', Buffer.concat([
      logRecord('[tca8418L] gpi release 99'), logRecord('[TTC] ignoring 1 short clicks'),
    ]), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(leftTargets(), [81]);
  });

  it('drains only the old file end captured when rollover is detected', async () => {
    const full = writeRaw('001.RAW', Buffer.alloc(0), Date.now() / 1000 - 5);
    await monitor.poll();
    appendRaw(full, Buffer.concat([Buffer.alloc((1 << 20) + 32), click('R', 97)]), Date.now() / 1000 - 1);
    writeRaw('002.RAW', click('L', 99), Date.now() / 1000);
    const fsp = (await import('node:fs/promises')).default;
    const open = fsp.open.bind(fsp);
    let appended = false;
    const opening = mock.method(fsp, 'open', async (file: string, flags: string) => {
      const handle = await open(file, flags);
      if (file === full && !appended) {
        appended = true;
        appendRaw(full, click('R', 99), Date.now() / 1000 - 1);
      }
      return handle;
    });
    try {
      await monitor.poll();
      assert.deepEqual(rightTargets(), [83]);
      assert.deepEqual(leftTargets(), [81]);
    } finally { opening.mock.restore(); }
  });

  it('caps an incomplete corrupt length at 64 KiB and recovers in the same file', async () => {
    const corrupt = Buffer.from([0xa2, 0x63, 0x73, 0x65, 0x71, 1, 0x64, 0x64, 0x61, 0x74, 0x61,
      0x5a, 0x00, 0x20, 0x00, 0x00]);
    const full = writeRaw('001.RAW', Buffer.concat([corrupt, Buffer.alloc(32 * 1024 - corrupt.length)]), Date.now() / 1000);
    await monitor.poll();
    assert.equal(monitor.tail?.carry.length, 32 * 1024);
    appendRaw(full, Buffer.alloc(32 * 1024), Date.now() / 1000);
    await monitor.poll();
    assert.equal(monitor.tail?.carry.length, 64 * 1024);
    appendRaw(full, Buffer.concat([Buffer.alloc(1), click('R', 97)]), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(rightTargets(), [83]);
    assert.equal(monitor.tail?.carry.length, 0);
    writeRaw('002.RAW', click('L', 99), Date.now() / 1000 + 0.01);
    await monitor.poll();
    assert.deepEqual(leftTargets(), [81]);
  });

  it('searches for record starts without decoding every stray byte', async () => {
    const decode = mock.method(cbor, 'decodeFirstSync');
    try {
      writeRaw('001.RAW', Buffer.alloc(8192, 0xff), Date.now() / 1000);
      await monitor.poll();
      assert.equal(decode.mock.callCount(), 0);
      assert.deepEqual(monitor.tail?.carry, Buffer.alloc(4, 0xff));
    } finally { decode.mock.restore(); }
  });

  for (const length of [1, 2, 3, 4]) {
    it(`carries a record start split after byte ${length}`, async () => {
      const whole = click('R', 97);
      const full = writeRaw('001.RAW', Buffer.concat([Buffer.alloc(16, 0xff), whole.subarray(0, length)]), Date.now() / 1000);
      await monitor.poll();
      assert.ok((monitor.tail?.carry.length ?? 0) <= 4);
      appendRaw(full, whole.subarray(length), Date.now() / 1000);
      await monitor.poll();
      assert.deepEqual(rightTargets(), [83]);
    });
  }

  it('clears a pending click when a separate chunk says the firmware changed the target', async () => {
    const full = writeRaw('001.RAW', Buffer.concat([
      logRecord('[tca8418R] gpi press 97'), logRecord('[tca8418R] gpi release 97'),
    ]), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(updates, []);
    appendRaw(full, logRecord('[thermostat] temp_up right -24->-14'), Date.now() / 1000);
    await monitor.poll();
    appendRaw(full, logRecord('[TTC] ignoring 1 short clicks'), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(updates, []);
  });

  it('skips sensor records, reversed outer keys and NUL padding', async () => {
    const sensor = frameRecord(1, cbor.encode({ type: 'piezo-dual', samples: Buffer.alloc(2048) }));
    const data = cbor.encode({ type: 'log', ts: Date.now() / 1000, msg: '[TTC] ignoring 1 short clicks' });
    writeRaw('001.RAW', Buffer.concat([
      sensor, Buffer.alloc(16),
      logRecord('[tca8418L] gpi press 99'), logRecord('[tca8418L] gpi release 99'),
      cbor.encode({ data, seq: 2 }), Buffer.alloc(16),
      frameRecord(2, data),
    ]), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(leftTargets(), [81]);
  });

  it('clamps a bottom click to the lower temperature limit', async () => {
    readTargets.left = 55;
    writeRaw('001.RAW', click('L', 99), Date.now() / 1000);
    await monitor.poll();
    assert.deepEqual(leftTargets(), [55]);
  });

  it('reports a press that could not be applied and keeps going', async () => {
    updateRejectsWith = new Error('franken write failed');
    const full = writeRaw('001.RAW', click('R', 97, 1), Date.now() / 1000);
    await monitor.poll();
    assert.equal(updates.length, 1);
    assert.deepEqual(manualChanges, []);
    assert.equal(serverStatus.status.buttonMonitor.status, 'failed');
    assert.match(serverStatus.status.buttonMonitor.message, /franken write failed/);

    updateRejectsWith = null;
    appendRaw(full, click('R', 97, 2), Date.now() / 1000);
    await monitor.poll();
    assert.equal(updates.length, 2);
    assert.equal(serverStatus.status.buttonMonitor.status, 'healthy');
  });
});

after(() => {
  rmSync(dataFolder, { recursive: true, force: true });
  rmSync(rawDir, { recursive: true, force: true });
});
