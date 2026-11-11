/** Report video thumbnails (FR2.3; BR2.3): YouTube still image, else a plain tile. */
import { describe, expect, it } from 'vitest';
import { clipThumbnail } from '../../src/lib/clipThumbnail';

const ID = 'dQw4w9WgXcQ';
const STILL = { kind: 'youtube', imageUrl: `https://img.youtube.com/vi/${ID}/hqdefault.jpg` };

describe('clipThumbnail', () => {
  it('gives the still image for a youtube.com watch link', () => {
    expect(clipThumbnail(`https://www.youtube.com/watch?v=${ID}&t=42s`)).toEqual(STILL);
  });

  it('gives the still image for a youtu.be share link', () => {
    expect(clipThumbnail(`https://youtu.be/${ID}?si=abc`)).toEqual(STILL);
  });

  it('gives the still image for shorts and embed links', () => {
    expect(clipThumbnail(`https://youtube.com/shorts/${ID}`)).toEqual(STILL);
    expect(clipThumbnail(`https://www.youtube.com/embed/${ID}`)).toEqual(STILL);
  });

  it('gives a tile for Streamable and direct video files', () => {
    expect(clipThumbnail('https://streamable.com/abc123')).toEqual({ kind: 'tile' });
    expect(clipThumbnail('https://cdn.example.test/clip.mp4')).toEqual({ kind: 'tile' });
  });

  it('gives a tile for a YouTube link with no video id, or text that is not a link', () => {
    expect(clipThumbnail('https://www.youtube.com/@channel')).toEqual({ kind: 'tile' });
    expect(clipThumbnail('not a url')).toEqual({ kind: 'tile' });
  });
});
