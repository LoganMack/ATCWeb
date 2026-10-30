/**
 * The incident clip player (BR5.2, BR5.3): builds what plays inside the Watch video popup for one clip link.
 * A YouTube link plays in a privacy-enhanced embed, a video file in a <video>, and anything else is offered as
 * a link. Nothing is built until the popup opens, and closing it empties the container, so no player keeps
 * loading in the background. Pure apart from the document it is handed, so tests can pass a small fake.
 */
import { clipKind } from '../lib/clipLink';

/** The bits of `document` the builder needs. */
export interface ClipDocument {
  createElement(tag: string): HTMLElement;
}

export const CLIP_LOAD_ERROR = "This clip couldn't be loaded";

/** A link that opens outside the site, never with access back to this page. */
function externalLink(doc: ClipDocument, href: string, text: string): HTMLElement {
  const a = doc.createElement('a');
  a.setAttribute('href', href);
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer');
  a.className = 'btn btn-primary btn-sm';
  a.textContent = text;
  return a;
}

/** The fallback shown when a clip can't play here: a short note and the link itself. */
export function buildClipFallback(
  doc: ClipDocument,
  url: string,
  note: string,
  linkText: string,
): HTMLElement {
  const box = doc.createElement('div');
  box.className =
    'flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-white/70';
  const p = doc.createElement('p');
  p.textContent = note;
  box.append(p, externalLink(doc, url, linkText));
  return box;
}

/**
 * The element that plays `url`, or null for a link that fails the clip check (nothing unchecked ever reaches a
 * src or href).
 */
export function buildClipPlayer(doc: ClipDocument, url: string): HTMLElement | null {
  const kind = clipKind(url);
  if (!kind) return null;
  const href = url.trim();

  if (kind.kind === 'youtube') {
    const frame = doc.createElement('iframe');
    frame.setAttribute('src', kind.embedUrl);
    frame.setAttribute('title', 'Incident video');
    frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.className = 'h-full w-full border-0';
    return frame;
  }

  if (kind.kind === 'file') {
    const video = doc.createElement('video');
    video.setAttribute('src', href);
    video.setAttribute('controls', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('preload', 'metadata');
    video.className = 'h-full w-full bg-black';
    // A file link that has expired or isn't really a video: swap in the link so it can still be opened.
    video.addEventListener('error', () => {
      video.replaceWith(buildClipFallback(doc, href, CLIP_LOAD_ERROR, 'Open link'));
    });
    return video;
  }

  return buildClipFallback(doc, href, "This clip can't be played here.", 'Open video');
}
