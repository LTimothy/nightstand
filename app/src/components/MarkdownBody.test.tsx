import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownBody from './MarkdownBody';

const SOURCES = ['src', 'srcset', 'poster', 'background', 'data', 'action', 'style'];

function renderMarkdown(markdown: string) {
  return render(<MarkdownBody markdown={ markdown } />).container;
}

function loadsResources(container: HTMLElement) {
  const tags = container.querySelectorAll('img, picture, source, video, audio, track, iframe, embed, object, svg, link, script, style, form');
  const attributes = [...container.querySelectorAll('*')].flatMap(element => SOURCES.filter(name => element.hasAttribute(name)));
  return tags.length + attributes.length > 0;
}

describe('MarkdownBody', () => {
  it('keeps bold, lists, code spans and links', () => {
    const container = renderMarkdown('**Fixed** `thing`\n\n- one\n- [two](https://example.com/two)');
    expect(container.querySelector('strong')?.textContent).toBe('Fixed');
    expect(container.querySelector('code')?.textContent).toBe('thing');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/two');
  });

  it('renders headings at body size', () => {
    const container = renderMarkdown('# Title\n\ntext');
    expect(getComputedStyle(container.querySelector('h1')!).fontSize).toBe('1rem');
  });

  it('renders a markdown image as a link to it, without loading it', () => {
    const container = renderMarkdown('![A screenshot](https://example.com/shot.png)');
    expect(loadsResources(container)).toBe(false);
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/shot.png');
    expect(link?.textContent).toBe('A screenshot');
  });

  it('falls back to the address when an image has no description', () => {
    const container = renderMarkdown('![](https://example.com/shot.png)');
    expect(loadsResources(container)).toBe(false);
    expect(container.querySelector('a')?.textContent).toBe('https://example.com/shot.png');
  });

  it.each([
    ['an img tag', '<img src="https://example.com/a.png">'],
    ['a picture with srcset', '<picture><source srcset="https://example.com/a.png"><img src="https://example.com/b.png"></picture>'],
    ['an iframe', '<iframe src="https://example.com/"></iframe>'],
    ['a video', '<video src="https://example.com/v.mp4" poster="https://example.com/p.png"></video>'],
    ['an audio element', '<audio src="https://example.com/a.mp3"></audio>'],
    ['an embedded object', '<object data="https://example.com/o.swf"></object><embed src="https://example.com/e.swf">'],
    ['an svg image', '<svg><image href="https://example.com/a.png"></image></svg>'],
    ['a stylesheet link', '<link rel="stylesheet" href="https://example.com/a.css">'],
    ['a style attribute', '<p style="background:url(https://example.com/a.png)">text</p>'],
    ['a style block', '<style>p { background: url(https://example.com/a.png) }</style>'],
    ['a table background', '<table background="https://example.com/a.png"><tr><td>x</td></tr></table>'],
  ])('drops %s', (_name, markup) => {
    const container = renderMarkdown(`Before\n\n${markup}\n\nAfter`);
    expect(loadsResources(container)).toBe(false);
    expect(container.innerHTML).not.toContain('example.com');
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('After');
  });
});
