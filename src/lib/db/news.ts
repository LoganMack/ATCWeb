import type { RestClient } from './client';
import type { NewsPost, NewsPostAdmin } from './types';

const PUBLIC_SELECT = 'id,slug,title,excerpt,body,cover_image_url,author_name,published_at';
const ADMIN_SELECT = 'id,slug,title,excerpt,body,cover_image_url,author_name,status,published_at';

export function newsRepo(rest: RestClient) {
  return {
    /**
     * Published posts, newest first. Sent with the anon key on purpose —
     * the "public read published news" policy in `0001_init.sql` is what
     * filters drafts out, so this can't accidentally leak one.
     */
    listPublished(limit?: number) {
      const params = new URLSearchParams({ select: PUBLIC_SELECT, order: 'published_at.desc' });
      if (limit) params.set('limit', String(limit));
      return rest.get<NewsPost[]>(`news_posts?${params.toString()}`);
    },

    async getBySlug(slug: string): Promise<NewsPost | null> {
      const rows = await rest.get<NewsPost[]>(
        `news_posts?select=${PUBLIC_SELECT}&slug=eq.${encodeURIComponent(slug)}&limit=1`
      );
      return rows[0] ?? null;
    },

    /** Drafts + published. Needs the admin's own token — RLS gates draft visibility. */
    listAll() {
      return rest.get<NewsPostAdmin[]>(`news_posts?select=${ADMIN_SELECT}&order=published_at.desc`, {
        authed: true,
      });
    },

    async getByIdAdmin(id: string): Promise<NewsPostAdmin | null> {
      const rows = await rest.get<NewsPostAdmin[]>(
        `news_posts?select=${ADMIN_SELECT}&id=eq.${encodeURIComponent(id)}`,
        { authed: true }
      );
      return rows[0] ?? null;
    },

    create(data: Partial<NewsPostAdmin>) {
      return rest.post<NewsPostAdmin>('news_posts', data);
    },

    update(id: string, data: Partial<NewsPostAdmin>) {
      return rest.patch<NewsPostAdmin>(`news_posts?id=eq.${encodeURIComponent(id)}`, data);
    },

    remove(id: string) {
      return rest.remove(`news_posts?id=eq.${encodeURIComponent(id)}`);
    },
  };
}
