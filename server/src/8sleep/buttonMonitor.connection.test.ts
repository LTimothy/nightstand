import assert from 'node:assert/strict';
import { before, beforeEach, after, describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import cbor from 'cbor';
import type { Socket } from 'node:net';
import type { DeviceStatus } from '../routes/deviceStatus/deviceStatusSchema.js';
import type { CommandOptions } from './frankenServer.js';

let franken: typeof import('./frankenServer.js');

const dataFolder = mkdtempSync(path.join(tmpdir(), 'button-connection-'));
const rawDir = path.join(dataFolder, 'raw');
mkdirSync(path.join(dataFolder, 'lowdb'));
mkdirSync(rawDir);
process.env.DATA_FOLDER = `${dataFolder}/`;
process.env.ENV = 'local';
process.env.POD_RAW_DIR = rawDir;
process.env.FRANKEN_CONNECT_WAIT_MS = '40';
process.env.FRANKEN_CONNECTION_TIMEOUT_MS = '0';

mock.module(new URL('../logger.js', import.meta.url).href, {
  defaultExport: { debug() {}, info() {}, warn() {}, error() {} },
});
mock.module(new URL('../jobs/scheduleOverride.js', import.meta.url).href, {
  namedExports: { markManualTempChange: async () => {} },
});

let physicalTarget = 82;
let writtenTargets: number[] = [];
let nextDecode: (() => Promise<void>) | null = null;
let afterDecode: (() => Promise<void>) | null = null;
let beforeWrite: (() => Promise<void>) | null = null;
let afterWrite: (() => void) | null = null;
let connectError: Error | null = null;
let connectionWait: Promise<Socket> | null = null;

// Only the transport is synthetic; queueing, coalescing and deadlines are real.
const makeSocket = (): Socket => new Duplex({
  read() {},
  write(data: Buffer, _encoding, done) {
    const [command, argument] = data.toString().trim().split('\n');
    let response = 'ok';
    if (command === '14') response = JSON.stringify({ right: { targetTemperatureF: physicalTarget } });
    if (command === '12') {
      physicalTarget = Number(argument);
      writtenTargets.push(physicalTarget);
    }
    this.push(`${response}\n\n`);
    done();
  },
}) as unknown as Socket;

mock.module(new URL('./unixSocketServer.js', import.meta.url).href, {
  namedExports: {
    UnixSocketServer: {
      start: async () => {
        if (connectError) throw connectError;
        return { close: async () => {}, waitForConnection: async () => connectionWait ?? makeSocket() };
      },
    },
  },
});
mock.module(new URL('./loadDeviceStatus.js', import.meta.url).href, {
  namedExports: {
    loadDeviceStatus: async (response: string) => {
      const status = JSON.parse(response) as DeviceStatus;
      const decoding = nextDecode;
      nextDecode = null;
      await decoding?.();
      await afterDecode?.();
      return status;
    },
  },
});
mock.module(new URL('../routes/deviceStatus/updateDeviceStatus.js', import.meta.url).href, {
  namedExports: {
    updateDeviceStatus: async (status: Partial<DeviceStatus>, options: CommandOptions = {}) => {
      await beforeWrite?.();
      const connection = await franken.connectFrankenWithin({ ...options, latest: true }, 'TEMP_LEVEL_RIGHT');
      await connection.callFunction('TEMP_LEVEL_RIGHT', String(status.right?.targetTemperatureF));
      afterWrite?.();
    },
  },
});

let ButtonMonitor: typeof import('./buttonMonitor.js')['ButtonMonitor'];
let settingsDB: typeof import('../db/settings.js')['default'];
let serverStatus: typeof import('../serverStatus.js')['default'];
type Internals = { poll(): Promise<void> };
let monitor: Internals;
const rawFile = path.join(rawDir, '001.RAW');
const click = () => Buffer.concat([
  '[tca8418R] gpi press 97', '[tca8418R] gpi release 97', '[TTC] ignoring 1 short clicks',
].map(msg => cbor.encode({ seq: 1, data: cbor.encode({ type: 'log', ts: Date.now() / 1000, msg }) })));

before(async () => {
  franken = await import('./frankenServer.js');
  ({ ButtonMonitor } = await import('./buttonMonitor.js'));
  ({ default: settingsDB } = await import('../db/settings.js'));
  ({ default: serverStatus } = await import('../serverStatus.js'));
});

beforeEach(async () => {
  await franken.disconnectFranken();
  physicalTarget = 82; writtenTargets = [];
  nextDecode = null; afterDecode = null; beforeWrite = null; afterWrite = null;
  connectError = null; connectionWait = null;
  for (const file of readdirSync(rawDir)) rmSync(path.join(rawDir, file));
  settingsDB.data.features.coverButtons = true;
  await settingsDB.write();
  monitor = new ButtonMonitor() as unknown as Internals;
  await monitor.poll();
});

describe('ButtonMonitor connection and status ordering', () => {
  it('does not reuse a coalesced status whose decoding crosses a completed write', async () => {
    let releaseDecode = () => {};
    let decodeStarted = () => {};
    const started = new Promise<void>(resolve => { decodeStarted = resolve; });
    const decoding = new Promise<void>(resolve => { releaseDecode = resolve; });
    let staleRead: Promise<DeviceStatus> | undefined;
    let waitingForDispatch = false;
    afterWrite = () => { waitingForDispatch = true; };
    const readSettings = settingsDB.read.bind(settingsDB);
    const reading = mock.method(settingsDB, 'read', async () => {
      await readSettings();
      if (waitingForDispatch) {
        waitingForDispatch = false;
        setImmediate(releaseDecode);
      }
    });
    beforeWrite = async () => {
      beforeWrite = null;
      nextDecode = async () => { decodeStarted(); await decoding; };
      staleRead = franken.getDeviceStatusCoalesced();
      await started;

    };
    try {
      writeFileSync(rawFile, Buffer.concat([click(), click()]));
      await monitor.poll();
      assert.deepEqual(writtenTargets, [83, 84]);
      releaseDecode();
      assert.equal((await staleRead)?.right.targetTemperatureF, 82);
    } finally {
      reading.mock.restore();
      releaseDecode();
      await staleRead;
    }
  });

  for (const rejects of [true, false]) {
    it(`resumes polling after connection ${rejects ? 'rejection' : 'timeout'} without replaying the click`, async () => {
      let reconnect: (socket: Socket) => void = () => {};
      if (rejects) connectError = new Error('connection refused');
      else connectionWait = new Promise(resolve => { reconnect = resolve; });
      writeFileSync(rawFile, click());
      const poll = monitor.poll();
      const lateConnection = setTimeout(() => reconnect(makeSocket()), 100);
      try {
        await poll;
        assert.equal(serverStatus.status.buttonMonitor.status, 'failed');
        settingsDB.data.features.coverButtons = false;
        await settingsDB.write();
        await monitor.poll();
        assert.match(serverStatus.status.buttonMonitor.message, /Off in Settings/);
        connectError = null;
        reconnect(makeSocket());
        await franken.connectFranken();
        assert.deepEqual(writtenTargets, []);
        settingsDB.data.features.coverButtons = true;
        await settingsDB.write();
        await monitor.poll();
        appendFileSync(rawFile, click());
        await monitor.poll();
        assert.deepEqual(writtenTargets, [83]);
      } finally { clearTimeout(lateConnection); }
    });
  }

  it('bounds reconnecting between the status read and write and never sends the old click', async () => {
    let reconnect: (socket: Socket) => void = () => {};
    let lateConnection: ReturnType<typeof setTimeout> | undefined;
    afterDecode = async () => {
      afterDecode = null;
      await franken.disconnectFranken();
      connectionWait = new Promise(resolve => { reconnect = resolve; });
      lateConnection = setTimeout(() => reconnect(makeSocket()), 100);
    };
    try {
      writeFileSync(rawFile, click());
      await monitor.poll();
      assert.equal(serverStatus.status.buttonMonitor.status, 'failed');
      settingsDB.data.features.coverButtons = false;
      await settingsDB.write();
      await monitor.poll();
      assert.match(serverStatus.status.buttonMonitor.message, /Off in Settings/);
      reconnect(makeSocket());
      await franken.connectFranken();
      assert.deepEqual(writtenTargets, []);
    } finally { clearTimeout(lateConnection); }
  });
});

after(async () => {
  await franken.disconnectFranken();
  rmSync(dataFolder, { recursive: true, force: true });
});
