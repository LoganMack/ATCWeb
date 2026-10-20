#!/usr/bin/env node
// Secret scan for schema dumps before they leave a protected job or enter this public repo.
//
//   node supabase/tools/secret-scan.mjs <file>...
//
// Exits 1 when any file has secret-shaped text. It prints only the file, line and kind of match,
// never the matched text, so the log of a failed scan does not leak what it found.
//
// `service_role` and `password` on their own are not flagged: `service_role` is a role name that
// appears in every grant and many policies, and `password` appears in auth column names. What is
// flagged is the shape of an actual credential next to them (a key, a JWT, a quoted password).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PATTERNS = [
  { kind: 'JWT (eyJ…)', regex: /eyJ[A-Za-z0-9_-]{10,}/ },
  { kind: 'service role key', regex: /service[_-]?role[_-]?(?:key|secret|jwt)/i },
  { kind: 'Supabase secret key', regex: /\bsb_secret_[A-Za-z0-9_-]{8,}/ },
  { kind: 'password value', regex: /password\s*(?:=|:|\s)\s*(?:E?'[^']+'|"[^"]+")/i },
  { kind: 'connection string', regex: /postgres(?:ql)?:\/\//i },
  { kind: 'credentials in a URL', regex: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^/\s@'"]+@/i },
  { kind: 'vault reference', regex: /\bvault\./i },
  { kind: 'sk_ API key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{20,}/ },
  { kind: 'bearer token', regex: /bearer\s+[A-Za-z0-9._~+/-]{16,}/i },
];

/** Returns [{ line, kind }] for every secret-shaped match in `text`. */
export function scanText(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const { kind, regex } of PATTERNS) if (regex.test(line)) hits.push({ line: index + 1, kind });
  });
  return hits;
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: secret-scan.mjs <file>...');
    process.exit(2);
  }
  let total = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`secret-scan: cannot read ${file}: ${error.message}`);
      process.exit(2);
    }
    for (const { line, kind } of scanText(text)) {
      console.error(`${file}:${line}: ${kind}`);
      total++;
    }
  }
  if (total > 0) {
    console.error(
      `Secret scan: ${total} secret-shaped match(es). Review the lines above before sharing the files.`,
    );
    process.exit(1);
  }
  console.log(`Secret scan: ${files.length} file(s) clean.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
