import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import express from 'express';
import logs from './logs.js';

type Gate = { wait: Promise<void>; open: () => void };
const gate = (): Gate => {
  let open = () => {};
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
};

const watchers: { closed: boolean }[] = [];
const watchCalls = () => watchers.length;
const openWatchers = () => watchers.filter(watcher => !watcher.closed).length;

const fakeWatch = () => {
  const watcher = Object.assign(new EventEmitter(), { closed: false, close() { watcher.closed = true; } });
  watchers.push(watcher);
  return watcher as unknown as fs.FSWatcher;
};

const start = async () => {
  const app = express();
  app.use('/api/logs', logs);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const sockets: Socket[] = [];
  server.on('connection', socket => sockets.push(socket));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/logs/free-sleep.log`;
  const stop = () => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return { url, sockets, stop };
};

// Waits until the server has seen the client hang up.
const hangUp = async (controller: AbortController, sockets: Socket[], request: Promise<unknown>) => {
  while (sockets.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await request.catch(() => {});
  await Promise.all(sockets.filter(socket => !socket.destroyed).map(socket => once(socket, 'close')));
  await new Promise(resolve => setTimeout(resolve, 20));
};

// Mocks made with t.mock are restored when each test ends.
afterEach(() => { watchers.length = 0; });

test('a client that hangs up while the log is being found leaves no watcher', async t => {
  const found = gate();
  let accessed = false;
  t.mock.method(fs.promises, 'access', async () => { accessed = true; await found.wait; });
  t.mock.method(fs.promises, 'open', async () => { throw new Error('no file'); });
  t.mock.method(fs, 'watch', fakeWatch);
  const { url, sockets, stop } = await start();
  t.after(stop);

  const controller = new AbortController();
  const request = fetch(url, { signal: controller.signal });
  while (!accessed) await new Promise(resolve => setTimeout(resolve, 5));
  await hangUp(controller, sockets, request);
  found.open();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(watchCalls(), 0);
  assert.equal(openWatchers(), 0);
});

test('a client that hangs up while the tail is being read leaves no watcher', async t => {
  const read = gate();
  let reading = false;
  t.mock.method(fs.promises, 'access', async () => {});
  t.mock.method(fs.promises, 'open', async () => { reading = true; await read.wait; throw new Error('rotated'); });
  t.mock.method(fs, 'watch', fakeWatch);
  const { url, sockets, stop } = await start();
  t.after(stop);

  const controller = new AbortController();
  const request = fetch(url, { signal: controller.signal });
  while (!reading) await new Promise(resolve => setTimeout(resolve, 5));
  await hangUp(controller, sockets, request);
  read.open();
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(watchCalls(), 0);
  assert.equal(openWatchers(), 0);
});

test('a client that hangs up mid-stream closes its watcher', async t => {
  t.mock.method(fs.promises, 'access', async () => {});
  t.mock.method(fs.promises, 'open', async () => { throw new Error('no file'); });
  t.mock.method(fs, 'watch', fakeWatch);
  const { url, sockets, stop } = await start();
  t.after(stop);

  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.ok(response.body);
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(openWatchers(), 1);
  await hangUp(controller, sockets, reader.read());

  assert.equal(watchCalls(), 1);
  assert.equal(openWatchers(), 0);
});

// Root's operation logs moved out of the server's log folder; older releases
// left copies of the same names behind there.
test('lists each log name once and reads root\'s operation logs first', async t => {
  t.mock.method(fs.promises, 'access', async () => {});
  t.mock.method(fs.promises, 'readdir', async (dir: string) =>
    (dir === '/var/log' ? [] : ['free-sleep-update.log']));
  t.mock.method(fs.promises, 'lstat', async () => ({ isFile: () => true, mtime: new Date(0) }));
  const { url, stop } = await start();
  t.after(stop);
  const list = await (await fetch(url.replace(/\/free-sleep\.log$/, ''))).json();
  assert.deepEqual(list, { logs: ['free-sleep-update.log'] });

  const checked: string[] = [];
  t.mock.method(fs.promises, 'access', async (file: string) => { checked.push(file); });
  t.mock.method(fs.promises, 'open', async () => { throw new Error('no file'); });
  t.mock.method(fs, 'watch', fakeWatch);
  const controller = new AbortController();
  const response = await fetch(url.replace('free-sleep.log', 'free-sleep-update.log'), { signal: controller.signal });
  await response.body?.getReader().read();
  controller.abort();
  assert.deepEqual(checked, ['/persistent/nightstand-logs/free-sleep-update.log']);
});
