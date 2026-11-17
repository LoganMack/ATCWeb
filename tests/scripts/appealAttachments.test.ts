import { describe, expect, it } from 'vitest';
import { addFiles, removeAt } from '../../src/scripts/appealAttachments';

const MB = 1024 * 1024;
const file = (name: string, size = 1000) => ({ name, size });

describe('addFiles', () => {
  it('adds files under the limits', () => {
    const result = addFiles([file('a.png')], [file('b.pdf'), file('c.txt')]);
    expect(result.files.map((f) => f.name)).toEqual(['a.png', 'b.pdf', 'c.txt']);
    expect(result.messages).toEqual([]);
  });

  it('refuses a file over 5 MB by name', () => {
    const result = addFiles([], [file('big.mp4', 5 * MB + 1)]);
    expect(result.files).toEqual([]);
    expect(result.messages).toEqual(['"big.mp4" is over 5 MB and wasn\'t added.']);
  });

  it('accepts a file of exactly 5 MB', () => {
    expect(addFiles([], [file('edge.mp4', 5 * MB)]).files).toHaveLength(1);
  });

  it('refuses a fourth file', () => {
    const result = addFiles([file('a'), file('b'), file('c')], [file('d')]);
    expect(result.files.map((f) => f.name)).toEqual(['a', 'b', 'c']);
    expect(result.messages).toEqual(['Only 3 files can be attached; "d" wasn\'t added.']);
  });

  it('keeps the order and the messages of a mixed batch', () => {
    const result = addFiles([file('a')], [file('big', 6 * MB), file('b'), file('c'), file('d')]);
    expect(result.files.map((f) => f.name)).toEqual(['a', 'b', 'c']);
    expect(result.messages).toEqual([
      '"big" is over 5 MB and wasn\'t added.',
      'Only 3 files can be attached; "d" wasn\'t added.',
    ]);
  });

  it('skips a file that is already listed', () => {
    const clip = { name: 'clip.mp4', size: 2000, lastModified: 1 };
    const result = addFiles([clip], [{ ...clip }, { name: 'clip.mp4', size: 2000, lastModified: 2 }]);
    expect(result.files).toHaveLength(2);
    expect(result.messages).toEqual([]);
  });

  it('leaves the current list unchanged', () => {
    const current = [file('a')];
    addFiles(current, [file('b')]);
    expect(current).toHaveLength(1);
  });
});

describe('removeAt', () => {
  const files = ['a', 'b', 'c'];

  it('removes the first, middle and last file', () => {
    expect(removeAt(files, 0)).toEqual(['b', 'c']);
    expect(removeAt(files, 1)).toEqual(['a', 'c']);
    expect(removeAt(files, 2)).toEqual(['a', 'b']);
  });

  it('changes nothing for an index outside the list', () => {
    expect(removeAt(files, -1)).toEqual(files);
    expect(removeAt(files, 3)).toEqual(files);
    expect(removeAt(files, 1.5)).toEqual(files);
  });
});
