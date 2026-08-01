/**
 * The transport layer: a few typed `fetch` wrappers over Supabase's
 * auto-generated PostgREST API and Storage API. Deliberately not
 * @supabase/supabase-js — for a read-mostly site this covers everything with
 * zero extra dependencies, and it runs on Cloudflare's edge runtime without
 * any compatibility caveats.
 *
 * WHICH KEY GETS USED, AND WHY IT LIVES HERE:
 *
 *   - Public reads send the anon key. RLS (`0001_init.sql`) allows those.
 *   - Reads that need to see more than the public can (news drafts,
 *     profiles) send the signed-in user's own access token — `get(path,
 *     { authed: true })`.
 *   - Every write sends the signed-in user's own access token, never the
 *     anon key. RLS (`0002_auth_admin.sql`) is what actually permits or
 *     rejects it; the middleware's /admin gate is a UX nicety on top.
 *
 * That rule used to live in the *naming* of a dozen exported functions
 * (`restGet` vs `restGetAuthed`) and in the discipline of every call site
 * remembering to pass an access token. Now it's structural: `post`/`patch`/
 * `remove`/`upload` throw if the client wasn't built with a token, so a
 * write can't silently go out under the anon key.
 */

import type { SiteEnv } from '../env';
import type { StorageBucket } from './types';

/** Carries the HTTP status through, so callers can distinguish 404 from 401 from a network failure. */
export class SupabaseError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string, message?: string) {
    super(message ?? `Supabase REST error ${status} on ${path}: ${body}`);
    this.name = 'SupabaseError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export interface RestClient {
  readonly env: SiteEnv;
  /** Null when nobody is signed in — writes throw rather than falling back to the anon key. */
  readonly accessToken: string | null;
  get<T>(path: string, opts?: { authed?: boolean }): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  remove(path: string): Promise<void>;
  upload(bucket: StorageBucket, objectPath: string, file: File): Promise<string>;
}

export function createRest(env: SiteEnv, accessToken: string | null): RestClient {
  function assertConfigured(path: string) {
    if (!env.supabaseUrl || !env.supabaseAnonKey) {
      throw new SupabaseError(
        0,
        path,
        '',
        'Supabase URL/anon key are not set (checked both Astro.locals.runtime.env and import.meta.env).'
      );
    }
  }

  function assertToken(path: string): string {
    if (!accessToken) {
      throw new SupabaseError(
        401,
        path,
        '',
        `This operation needs a signed-in user's access token, but the request has no session (${path}).`
      );
    }
    return accessToken;
  }

  function headers(token: string, extra?: Record<string, string>): Record<string, string> {
    return {
      // Supabase requires `apikey` on every REST call regardless of which
      // bearer token is in Authorization — it identifies the project.
      apikey: env.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      ...extra,
    };
  }

  async function send(method: string, path: string, init: RequestInit): Promise<Response> {
    assertConfigured(path);
    const res = await fetch(`${env.supabaseUrl}/rest/v1/${path}`, { method, ...init });
    if (!res.ok) throw new SupabaseError(res.status, path, await res.text());
    return res;
  }

  /**
   * PostgREST returns an array even for a single-row insert/update. Both
   * callers here use `Prefer: return=representation` and want the one row.
   */
  async function firstRow<T>(res: Response): Promise<T> {
    const rows = (await res.json()) as T[];
    return rows[0];
  }

  return {
    env,
    accessToken,

    async get<T>(path: string, opts?: { authed?: boolean }): Promise<T> {
      assertConfigured(path);
      const token = opts?.authed ? assertToken(path) : env.supabaseAnonKey;
      const res = await fetch(`${env.supabaseUrl}/rest/v1/${path}`, { headers: headers(token) });
      if (!res.ok) throw new SupabaseError(res.status, path, await res.text());
      return res.json() as Promise<T>;
    },

    async post<T>(path: string, body: unknown): Promise<T> {
      const token = assertToken(path);
      const res = await send('POST', path, {
        headers: headers(token, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(body),
      });
      return firstRow<T>(res);
    },

    async patch<T>(path: string, body: unknown): Promise<T> {
      const token = assertToken(path);
      const res = await send('PATCH', path, {
        headers: headers(token, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(body),
      });
      return firstRow<T>(res);
    },

    async remove(path: string): Promise<void> {
      const token = assertToken(path);
      await send('DELETE', path, { headers: headers(token) });
    },

    /**
     * Uploads to a public Storage bucket and returns the object's public URL.
     * `x-upsert` lets re-uploading to the same path (replacing a team's logo,
     * say) overwrite in place instead of erroring.
     */
    async upload(bucket: StorageBucket, objectPath: string, file: File): Promise<string> {
      assertConfigured(`storage/${bucket}/${objectPath}`);
      const token = assertToken(`storage/${bucket}/${objectPath}`);
      const res = await fetch(`${env.supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`, {
        method: 'POST',
        headers: headers(token, {
          'Content-Type': file.type || 'application/octet-stream',
          'x-upsert': 'true',
        }),
        body: file,
      });
      if (!res.ok) {
        throw new SupabaseError(res.status, `storage/${bucket}/${objectPath}`, await res.text());
      }
      return `${env.supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
    },
  };
}
