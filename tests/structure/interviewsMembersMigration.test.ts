/**
 * The members-only interviews migration (driver-profile-polish FR8.2-FR8.4, NFR1): the rules run in Postgres,
 * so these checks keep a later edit from dropping one silently. The SQL itself is exercised by the
 * migrations-rebuild job and check-view-embeds.mjs.
 */
import { describe, expect, it } from 'vitest';

const MIGRATIONS = import.meta.glob('/supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const DOWNS = import.meta.glob('/supabase/down/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const NAME = '20261107120000_interviews_members_view';
const sql = MIGRATIONS[`/supabase/migrations/${NAME}.sql`] ?? '';
const down = DOWNS[`/supabase/down/${NAME}.down.sql`] ?? '';
/** SQL without comment lines, so a rule mentioned only in prose does not count. */
const code = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

describe('interviews members view migration: files', () => {
  it('is named by the convention, ships its down script and explains itself', () => {
    expect(NAME).toMatch(/^\d{14}_[a-z0-9_]+$/);
    expect(sql).not.toBe('');
    expect(down).not.toBe('');
    expect(sql.startsWith('--')).toBe(true);
    expect(sql).toContain(`supabase/down/${NAME}.down.sql`);
    expect(sql).toMatch(/-- Why/);
    expect(sql).toMatch(/-- Expand only/);
  });
});

describe('race_interviews_shown (FR8.2, FR8.3)', () => {
  const body = code(sql);

  it('is a definer, security-barrier view', () => {
    expect(body).toContain(
      'create view public.race_interviews_shown with (security_invoker = false, security_barrier = true) as',
    );
  });

  it('returns rows to signed-in callers only and leaves out hidden drivers', () => {
    expect(body).toContain('where (select auth.uid()) is not null');
    expect(body).toMatch(
      /r\.driver_id <> all \(array\(\s+select h\.driver_id from private\.hidden_drivers h where h\.name_hidden\s+\)\)/,
    );
  });

  it('gives anon no grant and nobody a write', () => {
    expect(body).toContain(
      'revoke all on table public.race_interviews_shown from public, anon, authenticated, service_role;',
    );
    expect(body).toContain(
      'grant select on table public.race_interviews_shown to authenticated, service_role;',
    );
    expect(body).not.toMatch(/grant [^;]*race_interviews_shown[^;]*\banon\b/);
    expect(body).not.toMatch(/grant (insert|update|delete|all)[^;]*race_interviews_shown/);
  });

  it('does not expose the uploader', () => {
    const view = body.slice(body.indexOf('create view'), body.indexOf('comment on view'));
    expect(view).not.toContain('submitter_id');
  });
});

describe('members audio policy (FR8.4)', () => {
  const body = code(sql);

  it('lets signed-in callers read only audio the view shows them', () => {
    expect(body).toMatch(
      /create policy "members read shown race interviews" on storage\.objects\s+for select to authenticated/,
    );
    expect(body).toMatch(
      /bucket_id = 'race-interviews'\s+and exists \(select 1 from public\.race_interviews_shown s where s\.audio_path = objects\.name\)/,
    );
  });

  it('adds no write path to the bucket', () => {
    expect(body).not.toMatch(/for (insert|update|delete)/);
  });

  it('is undone by its down script, policy first', () => {
    const undo = code(down);
    const policy = undo.indexOf('drop policy "members read shown race interviews" on storage.objects;');
    const view = undo.indexOf('drop view public.race_interviews_shown;');
    expect(policy).toBeGreaterThanOrEqual(0);
    expect(view).toBeGreaterThan(policy);
  });
});
