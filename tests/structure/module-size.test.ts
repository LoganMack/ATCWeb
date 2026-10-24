/**
 * The size limit on the modules the module split creates (functional spec W2; FR4.3, BR2.1). Every
 * .ts file under the five split folders, src/lib/notifications and src/worker is at most 800 lines
 * unless it is listed below. A folder that doesn't exist yet (the later splits) contributes no files.
 */
import { describe, expect, it } from 'vitest';

// Bundled by Vite's glob import, so the test needs no Node file-system access.
const MODULES = import.meta.glob(
  [
    '/src/lib/db/**/*.ts',
    '/src/lib/results/**/*.ts',
    '/src/lib/penalties/**/*.ts',
    '/src/lib/incidentActions/**/*.ts',
    '/src/lib/driverPage/**/*.ts',
    '/src/lib/notifications/**/*.ts',
    '/src/worker/**/*.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const LIMIT = 800;

/**
 * Files allowed over the limit, keyed by path, each with a one-line reason. Only one cohesive
 * function over 800 lines on its own qualifies. Starts empty.
 */
const EXCEPTIONS: Record<string, string> = {};

/** Lines as an editor numbers them: a final newline doesn't start another line. */
function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split(/\r?\n/);
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function oversized(files: Record<string, string>, exceptions: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path, text]) => lineCount(text) > LIMIT && !(path in exceptions))
    .map(([path, text]) => `${path}: ${lineCount(text)} lines`);
}

describe('module size (W2, BR2.1)', () => {
  it('finds the split modules that exist', () => {
    expect(Object.keys(MODULES).some((p) => p.startsWith('/src/lib/penalties/'))).toBe(true);
  });

  it(`keeps every module in the split folders at ${LIMIT} lines or fewer`, () => {
    expect(oversized(MODULES, EXCEPTIONS)).toEqual([]);
  });

  it('lists only files that exist and are really over the limit', () => {
    for (const [path, reason] of Object.entries(EXCEPTIONS)) {
      expect(reason.trim(), `${path} needs a reason`).not.toBe('');
      expect(MODULES[path], `${path} is listed but missing`).toBeDefined();
      expect(lineCount(MODULES[path]), `${path} is listed but within the limit`).toBeGreaterThan(LIMIT);
    }
  });

  it('counts lines the way an editor numbers them', () => {
    expect(lineCount('')).toBe(0);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\r\nb\r\n')).toBe(2);
  });

  it('flags an 801-line module unless it is an exception', () => {
    const big = { '/src/lib/penalties/big.ts': 'x\n'.repeat(801) };
    const fits = { '/src/lib/penalties/fits.ts': 'x\n'.repeat(800) };
    expect(oversized(big, {})).toEqual(['/src/lib/penalties/big.ts: 801 lines']);
    expect(oversized(fits, {})).toEqual([]);
    expect(oversized(big, { '/src/lib/penalties/big.ts': 'one cohesive function' })).toEqual([]);
  });
});
