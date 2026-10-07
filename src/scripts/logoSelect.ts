/**
 * Dropdown with a logo beside each option — a native <select> can't show
 * images, so any <select data-logo-select> is enhanced into a custom
 * listbox. The real <select> stays in the DOM (visually hidden): it still
 * submits with its form, still carries `selected`, and when the visitor
 * picks something its value is set and a bubbling `change` event is
 * dispatched on it — so existing `onchange="this.form.submit()"` handlers
 * and delegated change listeners keep working untouched.
 *
 * Options may carry `data-logo` (and `data-logo-light`, swapped in for light
 * mode like SeasonLogo.astro does) — see lib/seasonSelect.ts. <optgroup>
 * labels become group headings. Options without a logo get an empty spacer so
 * text stays aligned.
 *
 * Content arrives late (loader scripts inject fragments; hard-form-submit
 * swaps the body), so rather than hooking page-load events this watches the
 * document for new `select[data-logo-select]` elements. Each is enhanced once.
 */
const LOGO_CLASS = 'h-5 w-5 flex-none rounded-sm object-contain';
const BUTTON_BASE = 'flex w-full items-center gap-2 rounded-md border border-white/15 bg-transparent text-left text-white outline-none hover:bg-white/5 focus:border-brand-primary focus:bg-white/5';
const PANEL_CLASS =
  'absolute left-0 top-full z-50 mt-1 hidden max-h-72 min-w-full overflow-auto rounded-md border border-white/15 bg-brand-ink py-1 shadow-lg';

let openInstance: { close: () => void } | null = null;

function logoNodes(dark: string | undefined, light: string | undefined, hasAnyLogo: boolean): Node[] {
  if (!dark) {
    if (!hasAnyLogo) return [];
    const spacer = document.createElement('span');
    spacer.className = 'h-5 w-5 flex-none';
    spacer.setAttribute('aria-hidden', 'true');
    return [spacer];
  }
  const make = (src: string, extra: string) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.className = `${LOGO_CLASS} ${extra}`.trim();
    return img;
  };
  if (light) return [make(dark, '[.light_&]:hidden'), make(light, 'hidden [.light_&]:block')];
  return [make(dark, '')];
}

function enhance(select: HTMLSelectElement) {
  if (select.dataset.logoSelectInit === 'true') return;
  select.dataset.logoSelectInit = 'true';

  const hasAnyLogo = [...select.options].some((o) => o.dataset.logo);

  // Width classes (w-*, max-w-*, min-w-*, flex-*) move to the wrapper; everything else is replaced.
  const sizing = [...select.classList].filter((c) => /^(w-|max-w-|min-w-|flex-|shrink|grow|sm:w-|sm:max-w-|ml-|mr-)/.test(c));
  const wrapper = document.createElement('div');
  wrapper.className = `relative ${sizing.length ? sizing.join(' ') : 'w-full sm:w-auto sm:min-w-[11rem]'}`;
  select.parentNode!.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  select.classList.add('sr-only');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const button = document.createElement('button');
  button.type = 'button';
  // Keeps the original select's own sizing (h-*, py-*, px-*, text size) so it sits level with its neighbours.
  const own = [...select.classList];
  const sized = own.filter((c) => /^(h-|py-|px-|text-(xs|sm|base))/.test(c));
  const hasHeight = own.some((c) => /^(h-|py-)/.test(c));
  button.className = `${BUTTON_BASE} ${hasHeight ? '' : 'h-9'} ${own.some((c) => /^px-/.test(c)) ? '' : 'px-3'} ${own.some((c) => /^text-(xs|sm|base)/.test(c)) ? '' : 'text-sm'} ${sized.join(' ')}`.replace(/\s+/g, ' ').trim();
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const ariaLabel = select.getAttribute('aria-label');
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  else if (select.labels?.[0]) button.setAttribute('aria-label', select.labels[0].textContent?.trim() ?? '');
  const current = document.createElement('span');
  current.className = 'flex min-w-0 flex-1 items-center gap-2';
  const chevron = document.createElement('span');
  chevron.className = 'flex-none text-[10px] text-white/50';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  button.append(current, chevron);

  const panel = document.createElement('ul');
  panel.className = PANEL_CLASS;
  panel.setAttribute('role', 'listbox');
  panel.tabIndex = -1;

  const items: { li: HTMLLIElement; option: HTMLOptionElement }[] = [];
  const addOption = (option: HTMLOptionElement) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.className = 'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-white hover:bg-white/10';
    li.append(...logoNodes(option.dataset.logo, option.dataset.logoLight, hasAnyLogo));
    const label = document.createElement('span');
    label.className = 'min-w-0 truncate';
    label.textContent = option.textContent?.trim() ?? '';
    li.appendChild(label);
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the button
    li.addEventListener('click', () => choose(option));
    panel.appendChild(li);
    items.push({ li, option });
  };
  for (const child of [...select.children]) {
    if (child instanceof HTMLOptGroupElement) {
      const heading = document.createElement('li');
      heading.setAttribute('role', 'presentation');
      heading.className = 'px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-white/40';
      heading.textContent = child.label;
      panel.appendChild(heading);
      for (const opt of child.querySelectorAll('option')) addOption(opt);
    } else if (child instanceof HTMLOptionElement) {
      addOption(child);
    }
  }

  let activeIndex = -1;
  const render = () => {
    current.replaceChildren();
    const selected = select.selectedOptions[0] ?? select.options[0];
    if (selected) {
      current.append(...logoNodes(selected.dataset.logo, selected.dataset.logoLight, false));
      const text = document.createElement('span');
      text.className = 'truncate';
      text.textContent = selected.textContent?.trim() ?? '';
      current.appendChild(text);
    }
    items.forEach(({ li, option }, i) => {
      const isSel = option === selected;
      li.setAttribute('aria-selected', String(isSel));
      li.classList.toggle('bg-white/10', i === activeIndex);
      li.classList.toggle('font-semibold', isSel);
    });
  };

  const setActive = (i: number) => {
    activeIndex = Math.max(0, Math.min(items.length - 1, i));
    render();
    items[activeIndex]?.li.scrollIntoView({ block: 'nearest' });
  };
  const open = () => {
    if (openInstance && openInstance !== api) openInstance.close();
    panel.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    openInstance = api;
    setActive(Math.max(0, items.findIndex(({ option }) => option.selected)));
  };
  const close = () => {
    panel.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
    render();
    if (openInstance === api) openInstance = null;
  };
  const api = { close };
  const choose = (option: HTMLOptionElement) => {
    const changed = select.value !== option.value;
    select.value = option.value;
    close();
    button.focus();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  button.addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close()));
  button.addEventListener('keydown', (e) => {
    const isOpen = !panel.classList.contains('hidden');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) open();
      else setActive(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isOpen) open();
      else if (items[activeIndex]) choose(items[activeIndex].option);
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab' && isOpen) {
      close();
    }
  });

  wrapper.append(button, panel);
  // Selection can also change programmatically (form.reset, back/forward cache restore).
  select.addEventListener('change', render);
  render();
}

function enhanceAll(root: ParentNode = document) {
  root.querySelectorAll<HTMLSelectElement>('select[data-logo-select]').forEach(enhance);
}

let scheduled = false;
function scheduleScan() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    enhanceAll();
  });
}

let initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
  enhanceAll();
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('mousedown', (e) => {
    if (openInstance && !(e.target as HTMLElement).closest('[role="listbox"], [role="combobox"]')) openInstance.close();
  });
  document.addEventListener('astro:page-load', scheduleScan);
}

init();

// Makes this file a module so its top-level names stay private (see tsconfig / other scripts).
export {};
