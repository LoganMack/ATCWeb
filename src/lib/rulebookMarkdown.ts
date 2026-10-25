/**
 * Rulebook markdown to HTML, shared by the public /rulebook page and the admin editor's live preview so the
 * two always match. GitHub-flavoured markdown through `marked`, with raw HTML shown as text, links kept only
 * for http(s), mailto and in-page anchors, and images shown as their alt text. One pass over the tokens also
 * gives the contents panel: every heading with a unique anchor id, and every table labelled from the heading
 * just above it.
 */
import { Marked, Renderer, type Token, type Tokens } from 'marked';
import { escapeHtml } from './security';

export interface RulebookHeading {
  id: string;
  text: string;
  level: number;
}

export interface RulebookTable {
  id: string;
  label: string;
}

export interface RenderedRulebook {
  html: string;
  /** Headings in document order, without those whose text starts with "Table:". */
  headings: RulebookHeading[];
  tables: RulebookTable[];
}

const TABLE_PREFIX = /^table:\s*/i;
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** A readable anchor id: lowercase words joined by hyphens ("6. Blue Flags" -> "6-blue-flags"). */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** True when a link may stay a link: http(s), mailto or a same-page anchor. */
export function isSafeRulebookHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith('#')) return trimmed.length > 1;
  try {
    return SAFE_PROTOCOLS.has(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

/** The visible text of inline tokens, with formatting and raw HTML dropped. */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens
    .map((t) => {
      if (t.type === 'html') return '';
      if ('tokens' in t && Array.isArray(t.tokens)) return plainText(t.tokens);
      return 'text' in t && typeof t.text === 'string' ? t.text : '';
    })
    .join('')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// Anchor ids for this render's heading and table tokens, read by the renderer below.
const anchorIds = new WeakMap<object, { id: string; label?: string }>();

/** Block tokens that hold more blocks, so headings and tables inside quotes and lists are found too. */
function childBlocks(token: Token): Token[][] {
  if (token.type === 'blockquote') return [(token as Tokens.Blockquote).tokens];
  if (token.type === 'list') return (token as Tokens.List).items.map((item) => item.tokens);
  return [];
}

function buildOutline(tokens: Token[]): Pick<RenderedRulebook, 'headings' | 'tables'> {
  const used = new Map<string, number>();
  const unique = (base: string) => {
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };
  const headings: RulebookHeading[] = [];
  const tables: RulebookTable[] = [];

  const walk = (blocks: Token[]) => {
    let previous: Token | null = null;
    for (const token of blocks) {
      if (token.type === 'heading') {
        const heading = token as Tokens.Heading;
        const text = plainText(heading.tokens);
        const id = unique(slugify(text) || 'section');
        anchorIds.set(token, { id });
        if (!TABLE_PREFIX.test(text)) headings.push({ id, text, level: heading.depth });
      } else if (token.type === 'table') {
        const n = tables.length + 1;
        const above = previous?.type === 'heading' ? plainText((previous as Tokens.Heading).tokens) : '';
        const label = above.replace(TABLE_PREFIX, '').trim() || `Table ${n}`;
        const id = unique(`table-${n}`);
        anchorIds.set(token, { id, label });
        tables.push({ id, label });
      }
      for (const inner of childBlocks(token)) walk(inner);
      if (token.type !== 'space') previous = token;
    }
  };
  walk(tokens);
  return { headings, tables };
}

const defaultRenderer = new Renderer();

const rulebookMarked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    heading(token) {
      const id = anchorIds.get(token)?.id;
      const inner = this.parser.parseInline(token.tokens);
      return `<h${token.depth}${id ? ` id="${escapeHtml(id)}" tabindex="-1"` : ''}>${inner}</h${token.depth}>\n`;
    },
    table(token) {
      const anchor = anchorIds.get(token);
      const table = defaultRenderer.table.call(this, token);
      if (!anchor) return `<div class="rulebook-table">${table}</div>\n`;
      const label = escapeHtml(anchor.label ?? '');
      return `<div class="rulebook-table" id="${escapeHtml(anchor.id)}" role="region" aria-label="${label}" tabindex="0">${table}</div>\n`;
    },
    link(token) {
      if (!isSafeRulebookHref(token.href)) return this.parser.parseInline(token.tokens);
      return defaultRenderer.link.call(this, token);
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

/** Renders rulebook markdown to safe HTML plus its heading and table outline. */
export function renderRulebook(markdown: string): RenderedRulebook {
  const tokens = rulebookMarked.lexer(markdown);
  const outline = buildOutline(tokens);
  const html = rulebookMarked.parser(tokens);
  return { html, ...outline };
}

// A warm Worker isolate renders each published version once (NFR1).
let memo: { id: number; result: RenderedRulebook } | null = null;

/** renderRulebook, memoised by version id for the public page. */
export function renderRulebookVersion(version: { id: number; body_md: string }): RenderedRulebook {
  if (memo?.id !== version.id) memo = { id: version.id, result: renderRulebook(version.body_md) };
  return memo.result;
}
