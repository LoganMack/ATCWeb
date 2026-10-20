import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/lib/csv';

describe('parseCsv', () => {
  it('splits rows on newlines and fields on commas', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a quoted comma inside one field', () => {
    expect(parseCsv('name,notes\n"Smith, J",x')).toEqual([
      ['name', 'notes'],
      ['Smith, J', 'x'],
    ]);
  });

  it('turns a doubled quote inside quotes into one quote', () => {
    expect(parseCsv('"say ""hi""",b')).toEqual([['say "hi"', 'b']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('"line one\nline two",c')).toEqual([['line one\nline two', 'c']]);
  });

  it('treats CRLF exactly like LF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('drops a trailing empty line', () => {
    expect(parseCsv('a\n1\n\n')).toEqual([['a'], ['1']]);
  });

  it('keeps empty fields between commas', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });

  it('keeps a leading BOM in the first header cell (normaliseHeader removes it later)', () => {
    const rows = parseCsv('﻿import_key,race_number\nk1,1');
    expect(rows[0][0]).toBe('﻿import_key');
    expect(rows[1]).toEqual(['k1', '1']);
  });
});
