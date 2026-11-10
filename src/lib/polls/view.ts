/**
 * The one renderer for a poll (FR1.8): the public page puts it in with set:html and the editor's preview
 * builds it in the browser, so the two cannot drift. Every control is disabled and there is no submit
 * button until voting arrives. All text is escaped; image URLs come from src/lib or local object URLs.
 */
import { escapeHtml } from '../security';
import { ANSWER_TYPE_LABELS, type PollView } from './types';

/** Only our own URL kinds reach an img src: Storage or resize URLs, same-site paths and local file previews. */
function safeImageUrl(url: string | null): string | null {
  if (!url) return null;
  return /^(https:\/\/|http:\/\/localhost[:/]|\/(?!\/)|blob:)/.test(url) ? url : null;
}

function optionImage(url: string | null): string {
  const src = safeImageUrl(url);
  if (!src) return '';
  return `<img src="${escapeHtml(src)}" alt="" width="64" height="64" loading="lazy" class="h-16 w-16 shrink-0 rounded-md object-cover" data-poll-option-image>`;
}

function choiceOption(
  type: 'radio' | 'checkbox',
  group: string,
  option: PollView['sections'][number]['options'][number],
): string {
  return (
    `<li><label class="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2">` +
    `<input type="${type}" name="${group}" disabled class="h-4 w-4 shrink-0">` +
    optionImage(option.imageUrl) +
    `<span class="text-white">${escapeHtml(option.name)}</span></label></li>`
  );
}

function starOption(group: string, option: PollView['sections'][number]['options'][number]): string {
  const name = escapeHtml(option.name);
  const stars = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<label class="inline-flex"><input type="radio" name="${group}" value="${n}" disabled class="sr-only" aria-label="${n} of 5 stars for ${name}">` +
        `<span aria-hidden="true" class="text-xl leading-none text-white/30">&#9733;</span></label>`,
    )
    .join('');
  return (
    `<li class="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 px-3 py-2">` +
    optionImage(option.imageUrl) +
    `<span class="flex-1 text-white">${name}</span>` +
    `<span class="inline-flex gap-1" role="radiogroup" aria-label="Rate ${name} from 1 to 5" data-poll-stars>${stars}</span></li>`
  );
}

function sectionHtml(section: PollView['sections'][number], i: number): string {
  const options = section.options
    .map((option, j) => {
      if (section.answerType === 'stars') return starOption(`poll-s${i}-o${j}`, option);
      return choiceOption(section.answerType === 'single' ? 'radio' : 'checkbox', `poll-s${i}`, option);
    })
    .join('');
  return (
    `<li><fieldset disabled class="rounded-xl border border-white/10 bg-brand-ink p-5" data-answer-type="${section.answerType}">` +
    `<legend class="px-1 font-display text-xl uppercase tracking-wide text-white">${escapeHtml(section.name)}</legend>` +
    `<p class="text-xs uppercase tracking-wide text-white/50">${ANSWER_TYPE_LABELS[section.answerType]}</p>` +
    `<ul class="mt-3 flex flex-col gap-2">${options}</ul></fieldset></li>`
  );
}

/** A poll as escaped HTML, with an optional note such as "Voting opens soon" (BR3.2, BR3.3). */
export function pollViewHtml(view: PollView, options: { note?: string | null } = {}): string {
  const description = view.description
    ? `<p class="mt-3 whitespace-pre-line text-white/70">${escapeHtml(view.description)}</p>`
    : '';
  const note = options.note
    ? `<p class="mt-4 inline-block rounded-lg border border-brand-gold/40 bg-brand-gold/10 px-3 py-1.5 text-sm text-brand-gold" data-poll-note>${escapeHtml(options.note)}</p>`
    : '';
  const sections = view.sections.map(sectionHtml).join('');
  return (
    `<article class="flex flex-col" data-poll-view>` +
    `<h2 class="font-display text-3xl uppercase tracking-wide text-white">${escapeHtml(view.title)}</h2>` +
    description +
    note +
    `<ol class="mt-6 flex flex-col gap-6">${sections}</ol></article>`
  );
}
