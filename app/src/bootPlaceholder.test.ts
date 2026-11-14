import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const html = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');

it('shows a status message inside #root before the app mounts', () => {
  const root = /<div id="root">([\s\S]*?)<script/.exec(html)?.[1] ?? '';
  expect(root).toContain('role="status"');
  expect(root).toContain('Loading Nightstand');
});

it('paints the page black before the app mounts', () => {
  expect(html).toMatch(/html, body \{[^}]*background: #000;[^}]*color-scheme: dark/);
});
