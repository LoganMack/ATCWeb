/**
 * The Stats > Circuits row loader (src/scripts/circuitLayoutDetail.ts; past-results BR8.13, NFR5.2): after a
 * row's fragment lands it re-dispatches astro:page-load once, so the new incidents table binds its sorting,
 * and never after a failed load, which leaves the row free to retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, type FakeDocument, type FakeElement } from './fakeDom';

let doc: FakeDocument;
let loadLayoutDetail: (row: HTMLElement) => Promise<void>;
let pageLoads: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  doc = installFakeDom();
  vi.resetModules();
  ({ loadLayoutDetail } = await import('../../src/scripts/circuitLayoutDetail'));
  // The module registers its own guarded listener; this one only counts.
  pageLoads = vi.fn();
  doc.addEventListener('astro:page-load', pageLoads);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function layoutRow(): { row: FakeElement; body: FakeElement } {
  const row = doc.createElement('tr');
  row.setAttribute('data-layout-detail-url', '/circuits/layout-detail/l1');
  const detail = doc.createElement('tr');
  const body = doc.createElement('div');
  body.setAttribute('data-layout-detail-body', '');
  detail.append(body);
  doc.body.append(doc.createElement('table'));
  doc.body.children[0].append(row, detail);
  return { row, body };
}

const load = (row: FakeElement) => loadLayoutDetail(row as unknown as HTMLElement);

describe('loadLayoutDetail', () => {
  it('fills the body and dispatches astro:page-load exactly once after a 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<table data-sortable></table>', { status: 200 })),
    );
    const { row, body } = layoutRow();
    await load(row);
    expect(pageLoads).toHaveBeenCalledTimes(1);
    // The fake DOM keeps innerHTML as a plain property.
    expect((body as unknown as { innerHTML: string }).innerHTML).toBe('<table data-sortable></table>');
    expect(row.dataset.detailLoaded).toBe('true');
  });

  it('dispatches nothing after a 500 and lets the row retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    const { row } = layoutRow();
    await load(row);
    expect(pageLoads).not.toHaveBeenCalled();
    expect(row.dataset.detailLoaded).toBe('false');
  });

  it('dispatches nothing after a rejected fetch and lets the row retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const { row } = layoutRow();
    await load(row);
    expect(pageLoads).not.toHaveBeenCalled();
    expect(row.dataset.detailLoaded).toBe('false');
  });
});
