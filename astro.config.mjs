import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';

// Hybrid rendering: pages are static by default (fast, free, cached at the
// edge) but any page that exports `prerender = false` is rendered on-demand
// via a Cloudflare Pages Function. We use that for the roster and news pages
// so editing data in Supabase shows up on the next page load — no rebuild
// or deploy needed.
export default defineConfig({
  output: 'hybrid',
  adapter: cloudflare({
    imageService: 'compile',
  }),
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
  ],
});
