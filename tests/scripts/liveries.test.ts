/**
 * The Liveries tab's browser helpers (profile-liveries FR5.6, FR5.9, FR5.10): the file checks before upload,
 * the gzip round trip that gives back the original bytes, and the answers it follows (only web links).
 */
import { describe, expect, it } from 'vitest';
import {
  downloadFilesOf,
  gunzipBlob,
  gzipBlob,
  linkOf,
  liveryFileProblem,
  saveName,
  uploadsOf,
} from '../../src/scripts/liveries';

const MB = 1024 * 1024;

describe('liveryFileProblem (FR5.10)', () => {
  it('accepts a .tga or .mip of up to 20 MB, whatever the case of the extension', () => {
    expect(liveryFileProblem({ name: 'car_123.TGA', size: 20 * MB }, '.tga')).toBeNull();
    expect(liveryFileProblem({ name: 'car_spec_123.mip', size: 1 }, '.mip')).toBeNull();
  });

  it('refuses the wrong extension for each picker', () => {
    expect(liveryFileProblem({ name: 'car.png', size: 10 }, '.tga')).toBe(
      'Pick a .tga file as the base livery.',
    );
    expect(liveryFileProblem({ name: 'car.tga', size: 10 }, '.mip')).toBe(
      'Pick a .mip file as the spec map.',
    );
  });

  it('refuses a file over 20 MB, naming the limit, and an empty file', () => {
    expect(liveryFileProblem({ name: 'car.tga', size: 20 * MB + 1 }, '.tga')).toBe(
      'Files can be at most 20 MB.',
    );
    expect(liveryFileProblem({ name: 'car.tga', size: 0 }, '.tga')).toBe('That file is empty.');
  });
});

describe('gzip round trip (FR5.9)', () => {
  it('compresses to gzip and gives back exactly the original bytes', async () => {
    const original = new Uint8Array(4096).map((_, i) => i % 7);
    const zipped = await gzipBlob(new Blob([original]));
    expect(zipped.type).toBe('application/gzip');
    expect(zipped.size).toBeLessThan(original.length);
    const bytes = new Uint8Array(await zipped.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const restored = new Uint8Array(await (await gunzipBlob(zipped)).arrayBuffer());
    expect(restored).toEqual(original);
  });

  it('rejects data that is not gzip', async () => {
    await expect(
      gunzipBlob(new Blob([new Uint8Array([1, 2, 3, 4])])).then((b) => b.arrayBuffer()),
    ).rejects.toThrow();
  });
});

describe('the answers the tab follows (FR5.6)', () => {
  it('reads the three upload links of prepare-livery and refuses anything but web links', () => {
    const data = {
      id: 'x',
      uploads: { base: 'https://s.test/b', thumb: 'https://s.test/t', preview: 'https://s.test/p' },
    };
    expect(uploadsOf({ ok: true, message: '', data })).toEqual({ id: 'x', ...data.uploads });
    expect(
      uploadsOf({
        ok: true,
        message: '',
        data: { ...data, uploads: { ...data.uploads, base: 'javascript:alert(1)' } },
      }),
    ).toBeNull();
    expect(uploadsOf({ ok: false, message: 'no', data })).toBeNull();
  });

  it('reads the download files with their original names, all or nothing', () => {
    const files = [
      { name: 'car.tga', url: 'https://s.test/a' },
      { name: 'car_spec.mip', url: 'https://s.test/b' },
    ];
    expect(downloadFilesOf({ ok: true, message: '', data: { files } })).toEqual(files);
    expect(
      downloadFilesOf({ ok: true, message: '', data: { files: [...files, { name: 'x', url: 'data:x' }] } }),
    ).toBeNull();
    expect(downloadFilesOf({ ok: true, message: '', data: { files: [] } })).toBeNull();
  });

  it('reads a single link and keeps a saved file name free of folders', () => {
    expect(linkOf({ ok: true, message: '', data: { url: 'https://s.test/p' } })).toBe('https://s.test/p');
    expect(linkOf({ ok: true, message: '', data: { url: '/relative' } })).toBeNull();
    expect(saveName('..\\..\\car.tga')).toBe('car.tga');
    expect(saveName('')).toBe('livery');
  });
});
