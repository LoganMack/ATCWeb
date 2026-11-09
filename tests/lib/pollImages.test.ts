/** Option image paths and URLs (src/lib/polls/images.ts; polls BR4.2, BR4.3). */
import { describe, expect, it } from 'vitest';
import {
  isPollImagePath,
  pollImageExtension,
  pollImagePath,
  pollImagePublicUrl,
} from '../../src/lib/polls/images';

const POLL_ID = '11111111-2222-4333-8444-555555555555';
// The pattern save_poll checks, written out as the migration has it.
const DB_PATTERN = new RegExp(`^${POLL_ID}/[A-Za-z0-9_-]+-[0-9]+\\.(png|jpg|webp)$`);

describe('pollImagePath', () => {
  it('builds <poll id>/<prefix>-<timestamp>.<ext>, matching the database pattern', () => {
    const path = pollImagePath(POLL_ID, 's1o2', 'image/png', 1763208000000);
    expect(path).toBe(`${POLL_ID}/s1o2-1763208000000.png`);
    expect(DB_PATTERN.test(path!)).toBe(true);
  });

  it('takes the extension from the file type', () => {
    expect(pollImagePath(POLL_ID, 'a', 'image/jpeg', 1)).toBe(`${POLL_ID}/a-1.jpg`);
    expect(pollImagePath(POLL_ID, 'a', 'image/webp', 1)).toBe(`${POLL_ID}/a-1.webp`);
    expect(pollImagePath(POLL_ID, 'a', 'image/gif', 1)).toBeNull();
    expect(pollImageExtension('image/svg+xml')).toBeNull();
  });

  it('cleans the prefix so a key can never leave the folder', () => {
    const path = pollImagePath(POLL_ID, '../../etc/x?#', 'image/png', 5)!;
    expect(path).toBe(`${POLL_ID}/etcx-5.png`);
    expect(DB_PATTERN.test(path)).toBe(true);
    expect(pollImagePath(POLL_ID, '...', 'image/png', 5)).toBe(`${POLL_ID}/option-5.png`);
  });
});

describe('isPollImagePath', () => {
  it('accepts only this poll folder and the allowed shapes', () => {
    expect(isPollImagePath(POLL_ID, `${POLL_ID}/a-1.png`)).toBe(true);
    expect(isPollImagePath(POLL_ID, `99999999-2222-4333-8444-555555555555/a-1.png`)).toBe(false);
    expect(isPollImagePath(POLL_ID, `${POLL_ID}/../a-1.png`)).toBe(false);
    expect(isPollImagePath(POLL_ID, `${POLL_ID}/a-1.gif`)).toBe(false);
    expect(isPollImagePath(POLL_ID, `${POLL_ID}/sub/a-1.png`)).toBe(false);
  });
});

describe('pollImagePublicUrl', () => {
  it('builds the public object URL that resizedImageUrl recognises', () => {
    expect(pollImagePublicUrl('https://abc.supabase.co', `${POLL_ID}/a-1.png`)).toBe(
      `https://abc.supabase.co/storage/v1/object/public/poll-images/${POLL_ID}/a-1.png`,
    );
  });
});
