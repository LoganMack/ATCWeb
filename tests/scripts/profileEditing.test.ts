/**
 * The own-profile editing script's pure parts (U3 profile-settings): dirty tracking for the held fields
 * (BR4.4), the browser-side photo and bio checks (NFR4.2), tab arrow keys, and the in-place helper that posts
 * FormData and never throws (C4, NFR4.4). The DOM wiring is not loaded in Node.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NETWORK_ERROR_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  bioProblem,
  inPlaceBody,
  isDirty,
  nextTabIndex,
  photoProblem,
  postInPlace,
  type HeldValues,
} from '../../src/scripts/profileEditing';

const loaded: HeldValues = {
  bio: 'Fast in the rain.',
  photoPicked: false,
  settings: { hide_profile: false, hide_name: true, notify_event_reminders: false },
};
const limits = { types: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 5 * 1024 * 1024 };

describe('isDirty (BR4.4)', () => {
  it('is clean while every held field matches what was loaded', () => {
    expect(isDirty(loaded, { ...loaded, settings: { ...loaded.settings } })).toBe(false);
  });

  it('notices a changed bio, a picked photo or a flipped checkbox', () => {
    expect(isDirty(loaded, { ...loaded, bio: 'Fast in the dry.' })).toBe(true);
    expect(isDirty(loaded, { ...loaded, photoPicked: true })).toBe(true);
    expect(isDirty(loaded, { ...loaded, settings: { ...loaded.settings, hide_profile: true } })).toBe(true);
  });

  it('treats a missing checkbox as unticked', () => {
    expect(isDirty(loaded, { ...loaded, settings: { hide_name: true } })).toBe(false);
    expect(isDirty(loaded, { ...loaded, settings: {} })).toBe(true);
  });
});

describe('browser-side checks (NFR4.2)', () => {
  it('accepts the allowed photo types up to the size limit', () => {
    expect(photoProblem({ type: 'image/webp', size: limits.maxBytes }, limits)).toBeNull();
  });

  it('refuses another type or a photo over the limit', () => {
    expect(photoProblem({ type: 'image/gif', size: 10 }, limits)).toBe('Photos must be PNG, JPG or WebP.');
    expect(photoProblem({ type: 'image/png', size: limits.maxBytes + 1 }, limits)).toBe(
      'Photos can be at most 5 MB.',
    );
  });

  it('checks the trimmed bio length the server checks', () => {
    expect(bioProblem(`${'x'.repeat(500)}   `, 500)).toBeNull();
    expect(bioProblem('x'.repeat(501), 500)).toBe('Your bio can be at most 500 characters.');
  });
});

describe('nextTabIndex', () => {
  it('moves with the arrow keys, wrapping, and jumps with Home and End', () => {
    expect(nextTabIndex(0, 'ArrowRight', 4)).toBe(1);
    expect(nextTabIndex(3, 'ArrowRight', 4)).toBe(0);
    expect(nextTabIndex(0, 'ArrowLeft', 4)).toBe(3);
    expect(nextTabIndex(2, 'Home', 4)).toBe(0);
    expect(nextTabIndex(1, 'End', 4)).toBe(3);
  });

  it('ignores other keys and an empty tablist', () => {
    expect(nextTabIndex(0, 'Enter', 4)).toBeNull();
    expect(nextTabIndex(0, 'ArrowRight', 0)).toBeNull();
  });
});

describe('postInPlace (C4, NFR4.4)', () => {
  const body = () => inPlaceBody('change-email', [['new_email', 'new@example.test']]);

  it('builds a body of the intent and its own fields only', () => {
    const form = inPlaceBody('reset-password', [
      ['intent', 'save-profile'],
      ['note', 'x'],
    ]);
    expect(form.getAll('intent')).toEqual(['reset-password']);
    expect(form.get('note')).toBe('x');
    expect(form.get('bio')).toBeNull();
  });

  it('posts FormData (never JSON, so the origin check applies) asking for a JSON answer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, message: 'Sent.' })));
    const result = await postInPlace('/drivers/abc', body(), { fetchImpl });
    expect(result).toEqual({ ok: true, message: 'Sent.' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/drivers/abc');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    expect((init.body as FormData).get('new_email')).toBe('new@example.test');
  });

  it('passes on an error answer with its field', async () => {
    const answer = {
      ok: false,
      message: 'That email is already used by another account.',
      field: 'new_email',
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answer), { status: 400 }));
    expect(await postInPlace('/drivers/abc', body(), { fetchImpl })).toEqual(answer);
  });

  it('turns a network failure into the inline message instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await postInPlace('/drivers/abc', body(), { fetchImpl })).toEqual({
      ok: false,
      message: NETWORK_ERROR_MESSAGE,
    });
  });

  it('gives up after the timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const result = await postInPlace('/drivers/abc', body(), {
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 5,
    });
    expect(result).toEqual({ ok: false, message: NETWORK_ERROR_MESSAGE });
  });

  it('treats a page that is not C4 JSON (a redirect to HTML, say) as an unexpected error', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html><p>Driver</p>', { status: 200 }));
    expect(await postInPlace('/drivers/abc', body(), { fetchImpl })).toEqual({
      ok: false,
      message: UNEXPECTED_ERROR_MESSAGE,
    });
  });
});
