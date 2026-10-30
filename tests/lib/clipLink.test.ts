/**
 * Incident clip links (BR5.1, BR5.2): the URL check shared by the server actions and the page scripts, how a
 * clip plays, and the messages for the database's clip errors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIP_URL_ERROR,
  CLIP_WRITE_MESSAGES,
  clipKind,
  clipWriteFailure,
  mapClipWriteError,
  normalizeClipUrl,
} from '../../src/lib/clipLink';

afterEach(() => vi.restoreAllMocks());

describe('normalizeClipUrl', () => {
  it('accepts http and https links', () => {
    expect(normalizeClipUrl('https://youtu.be/abc')).toEqual({ ok: true, url: 'https://youtu.be/abc' });
    expect(normalizeClipUrl('http://clips.example.test/a.mp4')).toEqual({
      ok: true,
      url: 'http://clips.example.test/a.mp4',
    });
    expect(normalizeClipUrl('HTTPS://Example.test/x')).toEqual({ ok: true, url: 'HTTPS://Example.test/x' });
  });

  it('trims, and treats an empty or all-space box as no clip', () => {
    expect(normalizeClipUrl('  https://youtu.be/abc \n')).toEqual({ ok: true, url: 'https://youtu.be/abc' });
    for (const empty of ['', '   ', null, undefined, 42]) {
      expect(normalizeClipUrl(empty)).toEqual({ ok: true, url: '' });
    }
  });

  it('allows 500 characters and refuses 501', () => {
    const base = 'https://x.test/';
    expect(normalizeClipUrl(base + 'a'.repeat(500 - base.length)).ok).toBe(true);
    expect(normalizeClipUrl(base + 'a'.repeat(501 - base.length))).toEqual({
      ok: false,
      message: CLIP_URL_ERROR,
    });
  });

  it('refuses other schemes, plain text and links with spaces, naming the Video URL field', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'ftp://x.test/a.mp4',
      'www.youtube.com/watch?v=abc',
      'just some words',
      'https://x.test/a clip.mp4',
      'https://',
    ]) {
      expect(normalizeClipUrl(bad)).toEqual({ ok: false, message: CLIP_URL_ERROR });
    }
    expect(CLIP_URL_ERROR).toMatch(/^Video URL: /);
  });
});

describe('clipKind', () => {
  it('plays YouTube links in the privacy-enhanced embed', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=abc123',
      'https://youtu.be/abc123',
      'https://youtube.com/shorts/abc123',
      'https://www.youtube.com/embed/abc123',
      'https://m.youtube.com/watch?v=abc123',
      'https://music.youtube.com/watch?v=abc123',
    ]) {
      expect(clipKind(url)).toEqual({
        kind: 'youtube',
        embedUrl: 'https://www.youtube-nocookie.com/embed/abc123',
      });
    }
  });

  it('plays video files and Discord attachments in a video player', () => {
    for (const url of [
      'https://clips.example.test/incident.mp4',
      'https://clips.example.test/incident.webm?x=1',
      'https://clips.example.test/INCIDENT.MOV',
      'https://clips.example.test/a.m4v',
      'https://clips.example.test/a.ogv',
      'https://cdn.discordapp.com/attachments/1/2/clip',
      'https://media.discordapp.net/attachments/1/2/clip',
    ]) {
      expect(clipKind(url)).toEqual({ kind: 'file' });
    }
  });

  it('shows anything else as a link, with no host allow-list', () => {
    expect(clipKind('https://streamable.com/abc')).toEqual({ kind: 'link' });
    expect(clipKind('https://www.youtube.com/channel/xyz')).toEqual({ kind: 'link' });
    expect(clipKind('https://clips.example.test/a.mp4.html')).toEqual({ kind: 'link' });
  });

  it('gives nothing for an empty or refused link, so it never reaches an href or src', () => {
    expect(clipKind('')).toBeNull();
    expect(clipKind('javascript:alert(1)')).toBeNull();
  });
});

describe('clip write errors', () => {
  it("maps the database's codes to plain messages", () => {
    const body = (message: string) =>
      `Supabase RPC error 400 on x: ${JSON.stringify({ code: 'P0001', message })}`;
    expect(mapClipWriteError(body('INVALID_URL: Video URL: …'))).toEqual({
      ok: false,
      code: 'INVALID_URL',
      message: CLIP_URL_ERROR,
    });
    expect(mapClipWriteError(body('REPORT_NOT_FOUND: gone')).message).toBe(
      'That incident report no longer exists.',
    );
    expect(mapClipWriteError(body('INCIDENT_NOT_FOUND: gone')).message).toBe(
      'That incident no longer exists.',
    );
    expect(mapClipWriteError(body('INCIDENT_NUMBER_REQUIRED: x')).code).toBe('INCIDENT_NUMBER_REQUIRED');
  });

  it('maps a refused caller and anything unknown', () => {
    const refused = `Supabase RPC error 403 on x: ${JSON.stringify({
      code: '42501',
      message: 'Only an admin or staff member can change a clip',
    })}`;
    expect(mapClipWriteError(refused)).toEqual({
      ok: false,
      code: 'NOT_ALLOWED',
      message: 'Only an admin or staff member can change a clip.',
    });
    expect(mapClipWriteError('network down')).toEqual({
      ok: false,
      code: 'UNKNOWN',
      message: CLIP_WRITE_MESSAGES.UNKNOWN,
    });
  });

  it('logs the function and code only, never the link', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = clipWriteFailure(
      'set_incident_video',
      new Error('INVALID_URL: https://secret.example.test/x'),
    );
    expect(result.code).toBe('INVALID_URL');
    expect(log).toHaveBeenCalledWith('set_incident_video failed', 'INVALID_URL');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret.example.test');
  });
});
