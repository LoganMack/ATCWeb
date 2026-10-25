// Admin > Rulebook's live preview, imported by src/pages/admin/rulebook.astro only. Renders the markdown box
// with the same module the public page uses (src/lib/rulebookMarkdown.ts), so raw HTML and unsafe links are
// neutralised here exactly as they are there.

import { renderRulebook } from '../lib/rulebookMarkdown';

const DEBOUNCE_MS = 200;
let timer: ReturnType<typeof setTimeout> | undefined;

function updatePreview(textarea: HTMLTextAreaElement): void {
  const preview = textarea
    .closest('[data-rulebook-editor]')
    ?.querySelector<HTMLElement>('[data-rulebook-preview]');
  if (!preview) return;
  // Safe to assign: renderRulebook escapes raw HTML and drops unsafe links and images.
  preview.innerHTML = renderRulebook(textarea.value).html;
}

function onInput(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || !target.matches('textarea[data-rulebook-body]')) return;
  clearTimeout(timer);
  timer = setTimeout(() => updatePreview(target), DEBOUNCE_MS);
}

// A module runs once per page load, so the delegated listener survives the client router swapping <body>.
if (typeof document !== 'undefined') document.addEventListener('input', onInput);
