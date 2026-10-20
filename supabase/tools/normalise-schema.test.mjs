// Tests for normalise-schema.mjs, using inline SQL in the shape pg_dump and
// dump-platform-objects.sql produce.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffSchemas } from './normalise-schema.mjs';

const TABLE = `
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
\\restrict a1b2c3
CREATE TABLE public.rounds (
    id bigint NOT NULL,
    season text
);
ALTER TABLE public.rounds OWNER TO postgres;
CREATE FUNCTION public.round_label(r public.rounds) RETURNS text
    LANGUAGE sql
    AS $$ select 'Round ' || r.id::text; -- not a comment boundary $$;
\\unrestrict a1b2c3
`;

const POLICY_A = `CREATE POLICY "Public read" ON storage.objects AS PERMISSIVE FOR SELECT TO public USING ((bucket_id = 'logos'::text));`;
const POLICY_B = `CREATE POLICY "Admins write" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (private.is_admin());`;
const BUCKET = `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('logos', 'logos', true, NULL, NULL) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`;

const empty = { removed: [], added: [] };

describe('normalise-schema', () => {
  it('ignores OWNER TO differences', () => {
    const other = TABLE.replace('OWNER TO postgres', 'OWNER TO supabase_admin');
    assert.deepEqual(diffSchemas(TABLE, other), empty);
    assert.deepEqual(
      diffSchemas(TABLE, TABLE.replace('ALTER TABLE public.rounds OWNER TO postgres;', '')),
      empty,
    );
  });

  it('ignores statement order in the platform part', () => {
    const a = [POLICY_A, POLICY_B, BUCKET].join('\n');
    const b = [BUCKET, POLICY_B, POLICY_A].join('\n');
    assert.deepEqual(diffSchemas(a, b), empty);
  });

  it('ignores comments', () => {
    const commented = `-- Name: rounds; Type: TABLE\n/* block /* nested */ comment */\n${TABLE}\n-- trailing comment`;
    assert.deepEqual(diffSchemas(TABLE, commented), empty);
  });

  it('reports an added column', () => {
    const wider = TABLE.replace('    season text\n', '    season text,\n    notes text\n');
    const { removed, added } = diffSchemas(TABLE, wider);
    assert.equal(removed.length, 1);
    assert.equal(added.length, 1);
    assert.match(added[0], /notes text/);
  });

  it('reports a changed policy expression', () => {
    const changed = POLICY_A.replace("'logos'", "'photos'");
    const { removed, added } = diffSchemas([POLICY_A, POLICY_B].join('\n'), [changed, POLICY_B].join('\n'));
    assert.deepEqual(removed, [POLICY_A]);
    assert.deepEqual(added, [changed]);
  });

  it('gives an empty diff for identical input', () => {
    const all = [TABLE, POLICY_A, POLICY_B, BUCKET].join('\n');
    assert.deepEqual(diffSchemas(all, all), empty);
  });
});
