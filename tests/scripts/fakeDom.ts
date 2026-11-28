/**
 * A small fake document for the DOM tests: Vitest runs in Node with no DOM, and the scripts under test only
 * need elements, attributes, text, events that bubble, focus, simple attribute selectors and native dialogs.
 * Selectors support a tag name and/or [attr], [attr="value"] and :not([attr]) parts, joined with spaces for
 * descendants.
 */
import { vi } from 'vitest';

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: FakeElement;
  key?: string;
  clientX?: number;
  relatedTarget?: FakeElement | null;
  defaultPrevented: boolean;
  preventDefault(): void;
}

const toAttr = (key: string) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

function matchesCompound(node: FakeElement, compound: string): boolean {
  let rest = compound.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest)?.[0];
  if (tag) {
    if (node.tagName !== tag.toUpperCase()) return false;
    rest = rest.slice(tag.length);
  }
  const part = /(:not\()?\[([\w-]+)(?:="([^"]*)")?\]\)?/g;
  // Fail loudly on anything else (an id, a class), rather than matching every element.
  if (rest.replace(part, '').trim()) throw new Error(`fakeDom: unsupported selector "${compound}"`);
  let match: RegExpExecArray | null;
  while ((match = part.exec(rest))) {
    const [, not, name, value] = match;
    const has = node.attributes.has(name) && (value === undefined || node.attributes.get(name) === value);
    if (not ? has : !has) return false;
  }
  return true;
}

export class FakeElement {
  tagName: string;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();
  value = '';
  clientWidth = 0;
  open = false;
  /** A checkbox's partly-ticked state: a property only, as in a real document. */
  indeterminate = false;
  private ownText = '';

  constructor(
    tag: string,
    readonly doc: FakeDocument,
  ) {
    this.tagName = tag === '#text' ? '#text' : tag.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  private flag(name: string, on: boolean) {
    if (on) this.attributes.set(name, '');
    else this.attributes.delete(name);
  }
  get disabled() {
    return this.attributes.has('disabled');
  }
  set disabled(on: boolean) {
    this.flag('disabled', on);
  }
  get hidden() {
    return this.attributes.has('hidden');
  }
  set hidden(on: boolean) {
    this.flag('hidden', on);
  }
  get checked() {
    return this.attributes.has('checked');
  }
  set checked(on: boolean) {
    this.flag('checked', on);
  }
  get id() {
    return this.attributes.get('id') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', value);
  }
  set type(value: string) {
    this.attributes.set('type', value);
  }
  get classes(): string[] {
    return (this.attributes.get('class') ?? '').split(/\s+/).filter(Boolean);
  }
  classList = {
    add: (...names: string[]) =>
      this.attributes.set('class', [...new Set([...this.classes, ...names])].join(' ')),
    remove: (...names: string[]) =>
      this.attributes.set('class', this.classes.filter((c) => !names.includes(c)).join(' ')),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.includes(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
    contains: (name: string) => this.classes.includes(name),
  };
  dataset = new Proxy({} as Record<string, string | undefined>, {
    get: (_t, key: string) => this.attributes.get(toAttr(key)),
    set: (_t, key: string, value: string) => {
      this.attributes.set(toAttr(key), value);
      return true;
    },
  });

  set textContent(value: string) {
    this.children.forEach((c) => (c.parent = null));
    this.children = [];
    this.ownText = value;
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  append(...nodes: (FakeElement | string)[]) {
    for (const n of nodes) {
      const child = typeof n === 'string' ? this.doc.createTextNode(n) : n;
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.textContent = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(other: FakeElement | null): boolean {
    for (let n = other; n; n = n.parent) if (n === this) return true;
    return false;
  }
  get nextElementSibling(): FakeElement | null {
    const siblings = this.parent?.children.filter((c) => c.tagName !== '#text') ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get tBodies(): FakeElement[] {
    return this.children.filter((c) => c.tagName === 'TBODY');
  }
  get isConnected(): boolean {
    return this.doc.body.contains(this) || this.doc.root.contains(this);
  }

  matches(selector: string): boolean {
    const parts = selector.trim().split(/\s+(?![^[]*\])/);
    if (!matchesCompound(this, parts[parts.length - 1])) return false;
    let ancestor = this.parent;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (ancestor && !matchesCompound(ancestor, parts[i])) ancestor = ancestor.parent;
      if (!ancestor) return false;
      ancestor = ancestor.parent;
    }
    return true;
  }
  closest(selector: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parent)
      if (n.tagName !== '#text' && n.matches(selector)) return n;
    return null;
  }
  all(predicate: (n: FakeElement) => boolean): FakeElement[] {
    return this.children.flatMap((c) => [...(predicate(c) ? [c] : []), ...c.all(predicate)]);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.all((n) => n.tagName !== '#text' && n.matches(selector));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Fires on this element, then bubbles to its ancestors (focus, blur and close do not bubble). */
  dispatch(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      ...init,
    };
    const bubbles = !['focus', 'blur', 'close', 'pointerleave'].includes(type);
    for (let n: FakeElement | null = this; n; n = bubbles ? n.parent : null) {
      for (const fn of n.listeners.get(type) ?? []) fn(event);
    }
    if (bubbles) for (const fn of this.doc.listeners.get(type) ?? []) fn(event);
    return event;
  }
  click() {
    if (!this.disabled) this.dispatch('click');
  }
  focus() {
    const before = this.doc.activeElement;
    this.doc.activeElement = this;
    if (before !== this) this.dispatch('focus');
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: 0 };
  }
  showModal() {
    this.open = true;
    this.attributes.set('open', '');
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.attributes.delete('open');
    this.dispatch('close');
  }
}

export class FakeDocument {
  root: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();
  constructor() {
    this.root = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.root.append(this.body);
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  createElementNS(_ns: string, tag: string) {
    const node = new FakeElement(tag, this);
    // SVG tags keep their case in a real document; the tests only compare upper-cased names.
    return node;
  }
  createTextNode(text: string) {
    const node = new FakeElement('#text', this);
    node.textContent = text;
    return node;
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Runs the document's own listeners for the event's type, in order, as a page-wide event does. */
  dispatchEvent(event: { type: string }): boolean {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event as FakeEvent);
    return true;
  }
  querySelector(selector: string) {
    return this.root.querySelector(selector);
  }
  querySelectorAll(selector: string) {
    return this.root.querySelectorAll(selector);
  }
}

/** Installs a fresh fake `document` (and CSS.escape) globally; undo with vi.unstubAllGlobals(). */
export function installFakeDom(): FakeDocument {
  const doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/g, '\\$&') });
  return doc;
}
