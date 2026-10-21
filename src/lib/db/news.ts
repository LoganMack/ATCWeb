import {
  restDelete,
  restGet,
  restGetAuthed,
  restPatch,
  restPost,
  type NewsPost,
  type SupabaseEnv,
} from './client';
import type { DriverOption } from './drivers';

// --- News (admin) ------------------------------------------------------

export interface NewsPostAdmin extends NewsPost {
  status: 'draft' | 'published';
}

const NEWS_ADMIN_SELECT =
  'id,slug,title,excerpt,body,cover_image_url,author_name,status,published_at,round_subsession_id,season_label';

/** Drafts + published, newest first — requires an admin's access token (RLS-gated). */
export function getAllNewsPosts(env: SupabaseEnv, accessToken: string) {
  return restGetAuthed<NewsPostAdmin[]>(
    env,
    accessToken,
    `news_posts?select=${NEWS_ADMIN_SELECT}&order=published_at.desc`,
  );
}

export async function getNewsPostByIdAdmin(env: SupabaseEnv, accessToken: string, id: string) {
  const posts = await restGetAuthed<NewsPostAdmin[]>(
    env,
    accessToken,
    `news_posts?select=${NEWS_ADMIN_SELECT}&id=eq.${encodeURIComponent(id)}`,
  );
  return posts[0] ?? null;
}

export function createNewsPost(env: SupabaseEnv, accessToken: string, data: Partial<NewsPostAdmin>) {
  return restPost<NewsPostAdmin>(env, accessToken, 'news_posts', data);
}

export function updateNewsPost(
  env: SupabaseEnv,
  accessToken: string,
  id: string,
  data: Partial<NewsPostAdmin>,
) {
  return restPatch<NewsPostAdmin>(env, accessToken, `news_posts?id=eq.${encodeURIComponent(id)}`, data);
}

export function deleteNewsPost(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `news_posts?id=eq.${encodeURIComponent(id)}`);
}

// --- News tags (0055_news_tags.sql) -----------------------------------
//
// Separate from the display-only "RESULTS" tag (derived straight from
// round_subsession_id, no table of its own — see NewsCard.astro/
// news/[slug].astro) — these are freely admin-managed labels a post can
// carry any number of, via the news_post_tags join table.

export interface NewsTag {
  id: string;
  name: string;
}

const NEWS_TAG_SELECT = 'id,name';

/** All tags, alphabetical — the admin tag-management page's list and the checkbox set on the post editor both use this. Public read (RLS), so no access token needed. */
export function getAllNewsTags(env: SupabaseEnv) {
  return restGet<NewsTag[]>(env, `news_tags?select=${NEWS_TAG_SELECT}&order=name.asc`);
}

export function createNewsTag(env: SupabaseEnv, accessToken: string, name: string) {
  return restPost<NewsTag>(env, accessToken, 'news_tags', { name });
}

export function deleteNewsTag(env: SupabaseEnv, accessToken: string, id: string) {
  return restDelete(env, accessToken, `news_tags?id=eq.${encodeURIComponent(id)}`);
}

export interface NewsPostTagLink {
  post_id: string;
  news_tags: { id: string; name: string } | null;
}

/** Every post<->tag link across every post, tag name embedded via PostgREST resource embedding — callers (NewsCard.astro's public pages) fetch this once and group it into a post_id -> NewsTag[] map, same "fetch once, map by id" convention as logoBySeasonLabel. Public read (RLS). */
export function getAllNewsPostTags(env: SupabaseEnv) {
  return restGet<NewsPostTagLink[]>(env, 'news_post_tags?select=post_id,news_tags(id,name)');
}

/** Tag ids currently assigned to one post — pre-checks the post editor's tag checkboxes. Public read (RLS). */
export async function getTagIdsForPost(env: SupabaseEnv, postId: string) {
  const rows = await restGet<{ tag_id: string }[]>(
    env,
    `news_post_tags?select=tag_id&post_id=eq.${encodeURIComponent(postId)}`,
  );
  return rows.map((r) => r.tag_id);
}

/** Full tag objects (id + name) assigned to one post — for the single-post detail page (news/[slug].astro), which only ever needs one post's worth and shouldn't pull every post's tag links like getAllNewsPostTags() does. */
export async function getTagsForPost(env: SupabaseEnv, postId: string): Promise<NewsTag[]> {
  const rows = await restGet<NewsPostTagLink[]>(
    env,
    `news_post_tags?select=post_id,news_tags(id,name)&post_id=eq.${encodeURIComponent(postId)}`,
  );
  return rows.map((r) => r.news_tags).filter((t): t is NewsTag => t !== null);
}

/** Delete-all-then-insert sync of a post's tag set from the editor's checkbox list — simplest correct approach for a small set, same pattern setOrganizationTeamForSeason() uses for its own many-to-many join table (0043_organizations.sql). */
export async function setPostTags(env: SupabaseEnv, accessToken: string, postId: string, tagIds: string[]) {
  await restDelete(env, accessToken, `news_post_tags?post_id=eq.${encodeURIComponent(postId)}`);
  if (tagIds.length === 0) return;
  await restPost(
    env,
    accessToken,
    'news_post_tags',
    tagIds.map((tag_id) => ({ post_id: postId, tag_id })),
  );
}

// --- News tagged drivers (0082_news_post_drivers.sql) -------------------
//
// Same many-to-many join-table shape/sync convention as news_post_tags just
// above, against `drivers` directly rather than a separate vocabulary
// table — the tagged driver's own name/profile IS the "tag." Powers the
// inline @-mention driver links rendered on a published post
// (news/[slug].astro) and, combined with a driver's own raced-rounds list,
// the "Related News" section on a driver's profile page
// (drivers/[id]/fragment.astro).
//
// There's no manual picker for this anymore (there used to be — a
// <select multiple>) — a post's tagged-driver set is entirely DERIVED from
// @-mentions typed straight into the body text via the admin editor's own
// autocomplete (src/pages/admin/news/new.astro and .../[id]/edit.astro),
// Discord-style. See extractMentionedDriverIds below for the token format
// and how a body string turns into the id list setPostDrivers syncs.

/**
 * A driver mention inserted by the admin editor's @-autocomplete is stored
 * right in the post's plain-text body as `@[Display Name](driverId)` — e.g.
 * "...huge move by @[Jane Doe](3fa85f64-5717-4562-b3fc-2c963f66afa6) into
 * turn 4..." This is deliberately NOT full Markdown (see the "no Markdown
 * dependency for MVP1" comment on news/[slug].astro's own paragraph
 * splitting) — it's a single special-cased token only ever produced by the
 * mention autocomplete, kept human-legible in the raw textarea (an admin
 * skimming the body still sees a real name, not an opaque id) while still
 * being trivially machine-parseable both server-side (this pattern) and
 * client-side (the same shape, matched ad hoc in the editor's own inline
 * script when rendering isn't needed there).
 */
export const MENTION_PATTERN = /@\[([^\]]+)\]\(([0-9a-fA-F-]{36})\)/g;

/**
 * Every driver id mentioned in a post body, deduped, in first-appearance
 * order — the sole source of truth for that post's news_post_drivers rows.
 * Called on every save (see setPostDrivers below), so a mention removed
 * from the text un-tags that driver on the next save, same as adding one
 * tags it; there's nothing else to keep in sync.
 */
export function extractMentionedDriverIds(body: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const id = match[2];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export interface NewsPostDriverLink {
  post_id: string;
  drivers: DriverOption | null;
}

/** Every post<->driver tag link across every post, driver name/car number embedded via PostgREST resource embedding — the driver profile page's "Related News" section fetches this once and filters it down to links naming that one driver, same "fetch once, map/filter in memory" convention getAllNewsPostTags uses. Public read (RLS). */
export function getAllNewsPostDrivers(env: SupabaseEnv) {
  return restGet<NewsPostDriverLink[]>(env, 'news_post_drivers?select=post_id,drivers(id,name,car_number)');
}

/** Driver ids currently tagged on one post. Public read (RLS). */
export async function getDriverIdsForPost(env: SupabaseEnv, postId: string) {
  const rows = await restGet<{ driver_id: string }[]>(
    env,
    `news_post_drivers?select=driver_id&post_id=eq.${encodeURIComponent(postId)}`,
  );
  return rows.map((r) => r.driver_id);
}

/** Full driver objects (id/name/car number) tagged on one post, alphabetical — for the single-post detail page (news/[slug].astro), which only ever needs one post's worth and shouldn't pull every post's driver links like getAllNewsPostDrivers() does. */
export async function getDriversForPost(env: SupabaseEnv, postId: string): Promise<DriverOption[]> {
  const rows = await restGet<NewsPostDriverLink[]>(
    env,
    `news_post_drivers?select=post_id,drivers(id,name,car_number)&post_id=eq.${encodeURIComponent(postId)}`,
  );
  return rows
    .map((r) => r.drivers)
    .filter((d): d is DriverOption => d !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Delete-all-then-insert sync of a post's tagged-driver set — same approach setPostTags() uses for news_post_tags. Callers pass extractMentionedDriverIds(body) rather than a manually-picked list (see this section's own header comment). */
export async function setPostDrivers(
  env: SupabaseEnv,
  accessToken: string,
  postId: string,
  driverIds: string[],
) {
  await restDelete(env, accessToken, `news_post_drivers?post_id=eq.${encodeURIComponent(postId)}`);
  if (driverIds.length === 0) return;
  await restPost(
    env,
    accessToken,
    'news_post_drivers',
    driverIds.map((driver_id) => ({ post_id: postId, driver_id })),
  );
}
