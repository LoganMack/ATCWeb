import type { APIRoute } from 'astro';
import { myProfilePath } from '../lib/auth';

export const prerender = false;

/**
 * The header's My Profile link. The header markup stays the same for every signed-out viewer (so cached
 * pages stay valid) and the destination is decided here from the session the middleware already resolved.
 */
export const GET: APIRoute = ({ locals, redirect }) => redirect(myProfilePath(locals), 302);
