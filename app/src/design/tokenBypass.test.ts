import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// A path join, not new URL('..', import.meta.url): that form is not a file URL under jsdom.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Not reachable from any route, kept on purpose; left as they are.
const UNREACHABLE = new Set([
  'pages/DataPage/DataPage.tsx', 'pages/SettingsPage/Divider.tsx', 'components/MovementChart.tsx',
]);
// Pills sized to half their height: round in every look.
const PILL_BY_HEIGHT = new Set([
  "components/SideControl.tsx '24px'", "pages/ControlTempPage/powerPill.ts '27px'", "pages/ControlTempPage/powerPill.ts '24px'",
  "pages/SchedulePage/DraftBar.tsx '24px'", "pages/SchedulePage/rhythms/UndoBar.tsx '24px'",
  'components/BedVisualization.tsx rx={ 5 }',
]);

const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const FILES = walk(SRC)
  .map(path => relative(SRC, path).split(sep).join('/'))
  .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !/\.d\.ts$/.test(file))
  .filter(file => !/^(mocks|test|design\/themes)\//.test(file) && !['design/tokens.ts', 'theme.ts'].includes(file))
  .filter(file => !UNREACHABLE.has(file));
const hits = (pattern: RegExp) => FILES.flatMap(file => [...readFileSync(join(SRC, file), 'utf8').matchAll(pattern)]
  .map(match => `${file} ${match[1] ?? match[0]}`));

it('reads every colour from the look', () => {
  expect(hits(/['"`](#[0-9a-f]{3,8})['"`]|(rgba?\()/gi)).toEqual([]);
});

// A template literal only passes when the sizes in it come from interpolated tokens.
const literalTemplateSize = (hit: string) => / `/.test(hit) && /[1-9]\d*(px|rem|em|%)/.test(hit.replace(/\$\{[^}]*\}/g, ''));

it('reads every corner from the look', () => {
  const corners = hits(/borderRadius: *('[^']*'|`[^`]*`|\d+)/g)
    .filter(hit => / `/.test(hit)
      ? literalTemplateSize(hit)
      : !/ ('0( !important)?'|0|1|2|'50%')$/.test(hit) && !PILL_BY_HEIGHT.has(hit));
  expect(corners).toEqual([]);
  // An SVG rect's corners too; an ellipse's rx and ry are its size, not a corner.
  const svgCorners = hits(/<rect\b[^>]*?\b(r[xy]=\{ *[\d.]+ *\})/g).filter(hit => !PILL_BY_HEIGHT.has(hit));
  expect(svgCorners).toEqual([]);
});

it('reads every font weight and family from the look', () => {
  expect(hits(/fontWeight(?:: *|=\{ *)(\d{3})/g)).toEqual([]);
  expect(hits(/fontFamily(?:: *|=)['"]([^'"]+)['"]/g).filter(hit => !/ (monospace|inherit)$/.test(hit))).toEqual([]);
});
