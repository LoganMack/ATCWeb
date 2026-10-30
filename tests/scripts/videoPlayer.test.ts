/**
 * The incident clip player (BR5.2, BR5.3): what the Watch video popup builds for each kind of link, the fallback
 * when a file won't play, and that closing the popup empties it. Vitest runs in Node with no DOM, so the
 * builder gets a small fake document.
 */
import { describe, expect, it } from 'vitest';
import { buildClipPlayer, CLIP_LOAD_ERROR, type ClipDocument } from '../../src/scripts/videoPlayer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

class FakeElement {
  tagName: string;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = '';
  textContent = '';
  listeners = new Map<string, (() => void)[]>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  append(...nodes: FakeElement[]) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceWith(node: FakeElement) {
    const parent = this.parent!;
    parent.children[parent.children.indexOf(this)] = node;
    node.parent = parent;
    this.parent = null;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  find(tag: string): FakeElement | undefined {
    for (const c of this.children) {
      if (c.tagName === tag.toUpperCase()) return c;
      const deeper = c.find(tag);
      if (deeper) return deeper;
    }
    return undefined;
  }
}

const doc = { createElement: (tag: string) => new FakeElement(tag) } as unknown as ClipDocument;
const build = (url: string) => buildClipPlayer(doc, url) as unknown as FakeElement | null;

describe('the clip player', () => {
  it('plays a YouTube link in the privacy-enhanced embed', () => {
    const frame = build('https://www.youtube.com/watch?v=dQw4w9WgXcQ')!;
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(frame.getAttribute('allow')).toBe('autoplay; encrypted-media; picture-in-picture');
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(frame.attributes.has('allowfullscreen')).toBe(true);
  });

  it('plays a video file in a <video> with controls', () => {
    const video = build('https://cdn.discordapp.com/attachments/1/2/clip.mp4')!;
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toBe('https://cdn.discordapp.com/attachments/1/2/clip.mp4');
    expect(video.attributes.has('controls')).toBe(true);
    expect(video.attributes.has('playsinline')).toBe(true);
  });

  it('offers any other link as an anchor that opens safely in a new tab', () => {
    const box = build('https://streamable.com/abc')!;
    const a = box.find('a')!;
    expect(a.getAttribute('href')).toBe('https://streamable.com/abc');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('Open video');
  });

  it("swaps a file that won't load for a note and the link", () => {
    const container = new FakeElement('div');
    const video = build('https://example.test/clip.webm')!;
    container.append(video);
    video.dispatch('error');
    const fallback = container.children[0];
    expect(fallback.tagName).toBe('DIV');
    expect(fallback.find('p')!.textContent).toBe(CLIP_LOAD_ERROR);
    const a = fallback.find('a')!;
    expect(a.textContent).toBe('Open link');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('builds nothing for a link that fails the clip check', () => {
    expect(build('javascript:alert(1)')).toBeNull();
    expect(build('')).toBeNull();
  });

  it('empties the player when the popup closes, so nothing keeps playing', () => {
    const script = readFileSync(resolve(__dirname, '../../src/scripts/videoClips.ts'), 'utf8');
    expect(script).toMatch(
      /'close',[\s\S]{0,300}\[data-video-player-dialog\][\s\S]{0,200}\[data-video-player-frame\]'\)\?\.replaceChildren\(\)/,
    );
    // Built only on open: the shell carries an empty frame.
    const shell = readFileSync(
      resolve(__dirname, '../../src/pages/results/[subsessionId]/incidents.astro'),
      'utf8',
    );
    expect(shell).toContain('<div data-video-player-frame class="aspect-video w-full bg-black"></div>');
  });
});
