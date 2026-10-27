import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Request, Response } from 'express';
import { FirmwareTelemetry } from '../../firmware/firmwareTelemetry.js';

const folder = mkdtempSync(`${tmpdir()}/firmware-route-`);
mkdirSync(`${folder}/lowdb`);
process.env.DATA_FOLDER = `${folder}/`;
process.env.ENV = 'local';
const { createFirmwareRouter, isLoopback } = await import('./firmware.js');
const flags = { firmwareTargetReadout: true, firmwareHealth: true, tapDiagnostics: false, coolingWarning: false };

it('accepts only actual loopback peers', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(peer), true);
  for (const peer of ['10.0.0.1', '127.0.0.1.evil', '::ffff:10.0.0.1', undefined]) assert.equal(isLoopback(peer), false);
});

async function post(body: unknown, peer = '127.0.0.1') {
  let status = 200;
  let configReads = 0;
  const router = createFirmwareRouter(new FirmwareTelemetry(), async () => {
    configReads++; return { features: flags, enabled: true };
  });
  await new Promise<void>((resolve, reject) => {
    const response = {
      status(code: number) { status = code; return this; },
      json() { resolve(); return this; },
      sendStatus(code: number) { status = code; resolve(); return this; },
    } as unknown as Response;
    const request = { method: 'POST', url: '/services/firmware', body, socket: { remoteAddress: peer },
      headers: { 'x-forwarded-for': '127.0.0.1' } } as unknown as Request;
    // Express's router dispatcher does not open a listener.
    (router as unknown as { handle: (req: Request, res: Response, next: (error?: unknown) => void) => void })
      .handle(request, response, error => error ? reject(error) : resolve());
  });
  return { status, configReads };
}

it('rejects remote requests even with a forwarded loopback address, before reading config', async () => {
  assert.deepEqual(await post({}, '10.0.0.1'), { status: 403, configReads: 0 });
});
it('strictly validates nested values and the batch byte bound', async () => {
  assert.equal((await post({ session: 'a'.repeat(32), records: [], text: 'private' })).status, 400);
  assert.equal((await post({ data: 'a'.repeat(65536) })).status, 413);
  const now = Date.now() / 1000;
  const record = { kind: 'sensor', timestamp: now, receivedAt: now, source: 'RAW', sequence: null, index: 0 };
  assert.equal((await post({ session: 'a'.repeat(32), records: [record] })).status, 204);
  assert.equal((await post({ session: 'a'.repeat(32), records: [{ ...record, arbitrary: 'text' }] })).status, 400);
});

it('feeds button click counts to the registry even with tapDiagnostics off', async () => {
  const { claimClicks, resetClickCounts } = await import('../../8sleep/clickCounts.js');
  resetClickCounts();
  const now = Math.floor(Date.now() / 1000);
  const record = { kind: 'tap', origin: 'buttonEvent', side: 'right', control: 'top', count: 3,
    timestamp: now, receivedAt: now, source: 'RAW', sequence: null, index: 0 };
  assert.equal((await post({ session: 'a'.repeat(32), records: [record] })).status, 204);
  assert.equal(claimClicks('right', 'tripleTap', now, now), 3);
});
