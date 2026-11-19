import { test, mock, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net, { type Socket, type Server, type AddressInfo } from 'node:net';
import type { DeviceStatus } from '../routes/deviceStatus/deviceStatusSchema.js';

const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-franken-lifecycle-'));
mkdirSync(path.join(folder, 'lowdb'));
const previousEnv = {
  DATA_FOLDER: process.env.DATA_FOLDER, ENV: process.env.ENV,
  FRANKEN_COMMAND_TOTAL_TIMEOUT_MS: process.env.FRANKEN_COMMAND_TOTAL_TIMEOUT_MS,
};
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
process.env.FRANKEN_COMMAND_TOTAL_TIMEOUT_MS = '100';
let socket: Socket;
const sockets: Socket[] = [];
let listener: Server;
let serverClosed = false;
mock.module(new URL('./unixSocketServer.js', import.meta.url).href, {
  namedExports: { UnixSocketServer: class {
    static async start() {
      const activeSocket = socket;
      return {
        waitForConnection: async () => activeSocket,
        close: async () => { serverClosed = true; activeSocket.destroy(); },
      };
    }
  } },
});
const {
  connectFranken, disconnectFranken, isFrankenConnected, getDeviceStatusCoalesced, FrankenCommandTimeoutError,
} = await import('./frankenServer.js');

async function connectSocket(echo = true) {
  const accepted = new Promise<Socket>(resolve => listener.once('connection', resolve));
  const client = net.createConnection((listener.address() as AddressInfo).port, '127.0.0.1');
  const peer = await accepted;
  sockets.push(client, peer);
  if (echo) peer.pipe(peer);
  else peer.pause();
  socket = client;
  return client;
}

beforeEach(async () => {
  serverClosed = false;
  listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  await connectSocket();
});
afterEach(async () => {
  await disconnectFranken();
  sockets.splice(0).forEach(connection => connection.destroy());
  await new Promise<void>(resolve => listener.close(() => resolve()));
});
after(() => {
  rmSync(folder, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('simultaneous status requests share the hardware operation', async t => {
  const franken = await connectFranken();
  let reads = 0;
  t.mock.method(franken, 'getDeviceStatus', async () => {
    reads += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return {} as DeviceStatus;
  });
  await Promise.all([getDeviceStatusCoalesced(), getDeviceStatusCoalesced(), getDeviceStatusCoalesced()]);
  assert.equal(reads, 1);
});

test('status coalescing does not discard a request for gestures', async t => {
  const franken = await connectFranken();
  const flags: boolean[] = [];
  t.mock.method(franken, 'getDeviceStatus', async (gestures = false) => {
    flags.push(gestures);
    await new Promise(resolve => setTimeout(resolve, 10));
    return {} as DeviceStatus;
  });
  const ordinary = getDeviceStatusCoalesced(false);
  await new Promise(resolve => setImmediate(resolve));
  await Promise.all([ordinary, getDeviceStatusCoalesced(true)]);
  assert.deepEqual(flags, [false, true]);
});

test('timeout destroys a backpressured socket and releases its queue and server', async () => {
  await connectSocket(false);
  const franken = await connectFranken();
  socket.write(Buffer.alloc(32 * 1024 * 1024));
  await assert.rejects(franken.sendMessage('14'), FrankenCommandTimeoutError);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(socket.destroyed, true);
  assert.equal(serverClosed, true);
  assert.equal(franken.sequentialQueue.depth(), 0);
});

test('a dropped connection is retired before the next hardware command', async () => {
  await connectSocket(false);
  const dropped = await connectFranken();
  const response = dropped.sendMessage('14');
  const rejected = assert.rejects(response, /connection closed/);
  await new Promise(resolve => setImmediate(resolve));
  socket.destroy();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(isFrankenConnected(), false);
  await connectSocket();
  const replacement = await connectFranken();
  assert.notEqual(replacement, dropped);
  assert.equal(await replacement.sendMessage('14'), '14');
});

test('a late close event from a retired socket leaves its replacement connected', async () => {
  await connectFranken();
  const retiredSocket = socket;
  const lateClose = retiredSocket.listeners('close').slice();
  await disconnectFranken();
  await connectSocket();
  const replacement = await connectFranken();
  for (const callback of lateClose) callback.call(retiredSocket, false);
  assert.equal(await connectFranken(), replacement);
  assert.equal(await replacement.sendMessage('14'), '14');
});

test('a late command timeout from a retired instance leaves its replacement connected', async t => {
  const retired = await connectFranken();
  t.mock.method(retired.sequentialQueue, 'exec', () => new Promise(() => {}));
  const rejected = assert.rejects(retired.sendMessage('14'), FrankenCommandTimeoutError);
  await disconnectFranken();
  await connectSocket();
  const replacement = await connectFranken();
  await rejected;
  assert.equal(await connectFranken(), replacement);
  assert.equal(await replacement.sendMessage('14'), '14');
});

test('a failing beforeSend rejects the command and writes nothing', async () => {
  const franken = await connectFranken();
  const write = mock.method(socket, 'write');
  await assert.rejects(franken.sendMessage('14', undefined, () => { throw new Error('busy'); }), /busy/);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(await franken.sendMessage('14'), '14');
});
