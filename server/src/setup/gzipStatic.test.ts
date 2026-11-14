import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { gzipStatic } from './gzipStatic.js';

const BODY = 'console.log("nightstand");\n'.repeat(500);
let dir: string;
let server: http.Server;
let port: number;

function get(p: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      http.get({ port, path: p, headers: { 'accept-encoding': 'identity', ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    },
  );
}

describe('gzipStatic', () => {
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gzs-'));
    fs.writeFileSync(path.join(dir, 'app.js'), BODY);
    fs.writeFileSync(path.join(dir, 'app.css'), 'a{color:red}\n'.repeat(200));
    fs.writeFileSync(path.join(dir, 'later.js'), BODY);
    const app = express();
    app.use(gzipStatic(dir));
    app.use(express.static(dir, {
      setHeaders: (res, file) => {
        if (/\.(js|css)$/.test(file)) res.setHeader('Vary', 'Accept-Encoding');
      },
    }));
    server = app.listen(0);
    port = (server.address() as AddressInfo).port;
  });

  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves a gzip body that decompresses to the file', async () => {
    const r = await get('/app.js', { 'accept-encoding': 'gzip, deflate' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    assert.match(String(r.headers['content-type']), /javascript/);
    assert.strictEqual(r.headers.vary, 'Accept-Encoding');
    assert.strictEqual(r.headers['cache-control'], 'public, max-age=0');
    assert.match(String(r.headers.etag), /-gz"$/);
    assert.strictEqual(zlib.gunzipSync(r.body).toString(), BODY);
  });

  it('serves css as text/css', async () => {
    const r = await get('/app.css', { 'accept-encoding': 'gzip' });
    assert.match(String(r.headers['content-type']), /text\/css/);
  });

  it('serves identity with Vary when gzip is not accepted', async () => {
    const r = await get('/app.js');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-encoding'], undefined);
    assert.strictEqual(r.headers.vary, 'Accept-Encoding');
    assert.strictEqual(r.body.toString(), BODY);
  });

  it('answers a matching If-None-Match with 304 and Vary', async () => {
    const first = await get('/app.js', { 'accept-encoding': 'gzip' });
    const r = await get('/app.js', {
      'accept-encoding': 'gzip',
      'if-none-match': String(first.headers.etag),
    });
    assert.strictEqual(r.status, 304);
    assert.strictEqual(r.headers.vary, 'Accept-Encoding');
  });

  it('passes Range requests through to identity', async () => {
    const r = await get('/app.js', { 'accept-encoding': 'gzip', range: 'bytes=0-9' });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers['content-encoding'], undefined);
    assert.strictEqual(r.body.length, 10);
  });

  it('passes unknown names and files added later through', async () => {
    fs.writeFileSync(path.join(dir, 'added.js'), BODY);
    const r = await get('/added.js', { 'accept-encoding': 'gzip' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-encoding'], undefined);
    assert.strictEqual((await get('/nope.js', { 'accept-encoding': 'gzip' })).status, 404);
  });

  it('does not fail when the directory is missing', () => {
    assert.doesNotThrow(() => gzipStatic(path.join(dir, 'missing')));
  });

  it('compresses once for concurrent first requests', async (t) => {
    const spy = t.mock.method(zlib, 'gzip');
    const hdr = { 'accept-encoding': 'gzip' };
    const rs = await Promise.all([get('/later.js', hdr), get('/later.js', hdr)]);
    assert.ok(rs.every((r) => r.headers['content-encoding'] === 'gzip'));
    assert.strictEqual(spy.mock.callCount(), 1);
  });
});
