/**
 * The two profile-liveries migrations (FR2.6, FR5.3, FR5.4, FR5.7, FR5.11, NFR1, NFR2): each has its down
 * script, and the SQL carries the database rules the page relies on. The rules themselves run in Postgres;
 * these checks keep a later edit from dropping one silently.
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

const HIDE = '20261105120000_hide_name_forces_hide_profile';
const LIVERIES = '20261106120000_liveries';
const sql = (name: string) => MIGRATIONS[`/supabase/migrations/${name}.sql`] ?? '';
const down = (name: string) => DOWNS[`/supabase/down/${name}.down.sql`] ?? '';
/** SQL without comment lines, so a rule mentioned only in prose does not count. */
const code = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

describe('profile-liveries migrations: files', () => {
  it.each([HIDE, LIVERIES])('%s is named by the convention and ships its down script', (name) => {
    expect(name).toMatch(/^\d{14}_[a-z0-9_]+$/);
    expect(sql(name)).not.toBe('');
    expect(down(name)).not.toBe('');
  });

  it.each([HIDE, LIVERIES])('%s opens with a header that says what, why and how to undo', (name) => {
    const header = sql(name).split(/\r?\n/).slice(0, 5).join('\n');
    expect(header.startsWith('--')).toBe(true);
    expect(sql(name)).toContain(`supabase/down/${name}.down.sql`);
    expect(sql(name)).toMatch(/-- Why/);
    expect(sql(name)).toMatch(/-- Expand only/);
  });
});

describe('hide name forces hide profile (FR2.6)', () => {
  const body = code(sql(HIDE));

  it('coerces hide_profile in a before insert or update trigger', () => {
    expect(body).toMatch(/before insert or update on public\.account_settings/);
    expect(body).toMatch(/if new\.hide_name then\s+new\.hide_profile := true;/);
    expect(body).toMatch(/set search_path = ''/);
  });

  it('backs the rule with a check constraint', () => {
    expect(body).toContain(
      'add constraint account_settings_hide_name_hides_profile check (not hide_name or hide_profile)',
    );
  });

  it('is undone by its down script', () => {
    const undo = code(down(HIDE));
    expect(undo).toContain('drop constraint account_settings_hide_name_hides_profile');
    expect(undo).toContain('drop trigger account_settings_hide_name_forces_hide_profile');
    expect(undo).toContain('drop function private.account_settings_force_hide_profile()');
  });
});

describe('liveries (FR5)', () => {
  const body = code(sql(LIVERIES));

  it('enables Row Level Security with owner writes and owner or admin reads (FR5.11)', () => {
    expect(body).toContain('alter table public.liveries enable row level security;');
    expect(body).toMatch(
      /create policy liveries_select[\s\S]*?using \(profile_id = \(select auth\.uid\(\)\) or public\.is_admin\(\)\)/,
    );
    expect(body).toMatch(/create policy liveries_insert[\s\S]*?p\.driver_id is not null/);
    expect(body).toMatch(
      /create policy liveries_update[\s\S]*?using \(profile_id = \(select auth\.uid\(\)\)\)/,
    );
    expect(body).toMatch(
      /create policy liveries_delete[\s\S]*?using \(profile_id = \(select auth\.uid\(\)\)\)/,
    );
  });

  it('grants only the columns the page writes', () => {
    expect(body).toContain('revoke all on table public.liveries from public, anon, authenticated;');
    expect(body).toContain('grant insert (id, season_id, tga_name, tga_size) on table public.liveries');
    expect(body).toContain(
      'grant update (season_id, is_active, mip_name, mip_size) on table public.liveries',
    );
  });

  it('keeps one active livery per account and season (FR5.7)', () => {
    expect(body).toContain(
      'create unique index liveries_one_active_per_season on public.liveries (profile_id, season_id) where is_active;',
    );
    expect(body).toMatch(/new\.season_id is distinct from old\.season_id then\s+new\.is_active := false;/);
  });

  it('refuses a fourth livery in a season under a per-account lock (FR5.3)', () => {
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toMatch(/if v_count >= 3 then\s+raise exception 'LIMIT_REACHED:/);
  });

  it('refuses a row or a spec map whose files are missing (FR5.4)', () => {
    expect(body).toMatch(
      /'base\.tga\.gz'[\s\S]*'thumb'[\s\S]*'preview'[\s\S]*FILES_MISSING: upload the livery files/,
    );
    expect(body).toMatch(/'spec\.mip\.gz'[\s\S]*FILES_MISSING: upload the spec map first/);
  });

  it('limits sizes and names to .tga / .mip of at most 20 MB (FR5.10)', () => {
    expect(body).toContain("lower(tga_name) like '%.tga'");
    expect(body).toContain("lower(mip_name) like '%.mip'");
    expect(body).toContain('check (tga_size between 1 and 20971520)');
    expect(body).toContain('check (mip_size between 1 and 20971520)');
  });

  it('runs its definer trigger with an empty search path', () => {
    expect(body).toMatch(
      /private\.liveries_before_write\(\) returns trigger\s+language plpgsql security definer\s+set search_path = ''/,
    );
  });

  it('creates a private bucket with a size limit and a MIME allowlist (NFR2)', () => {
    expect(body).toMatch(
      /values \('liveries', 'liveries', false, 22020096, '\{application\/gzip,image\/webp,image\/jpeg\}'::text\[\]\)/,
    );
  });

  it('limits storage to the owner folder, with admin reads (NFR1)', () => {
    for (const policy of [
      'owner upload own liveries',
      'owner read own liveries',
      'owner replace own liveries',
      'owner delete own liveries',
      'admin read liveries',
    ]) {
      expect(body).toContain(`create policy "${policy}" on storage.objects`);
      expect(code(down(LIVERIES))).toContain(`drop policy "${policy}" on storage.objects`);
    }
    expect(body.match(/\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/g)?.length).toBe(
      5,
    );
  });

  it('is undone by its down script', () => {
    const undo = code(down(LIVERIES));
    expect(undo).toContain("delete from storage.buckets where id = 'liveries';");
    expect(undo).toContain('drop function public.set_my_livery_active(uuid);');
    expect(undo).toContain('drop table public.liveries;');
    expect(undo).toContain('drop function private.liveries_before_write();');
  });
});
