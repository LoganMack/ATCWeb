/**
 * PLACEHOLDER PALETTE — approximated by eye from the ATC17/18 logos shown in
 * chat (not extracted from the actual files, since those weren't available
 * as attachments yet). Swap these four hex values once the real files/hex
 * codes are provided; nothing else in the codebase needs to change.
 */
const brand = {
  pink: '#E8225C',   // logo's magenta/pink sweep
  blue: '#3457E0',   // logo's blue sweep
  gold: '#F2B531',   // logo's gold accent arrow
  ink: '#0B0B0E',    // near-black background
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand,
      },
      fontFamily: {
        // `display` is for headlines/titles/numbers — historically Cuatra,
        // falling back to Teko/Russo One (both open-source, similar
        // condensed-technical feel) until Cuatra's license + files are
        // confirmed and self-hosted.
        display: ['Cuatra', 'Teko', 'Russo One', 'system-ui', 'sans-serif'],
        // `body` is regular text — Roboto per your existing brand.
        body: ['Roboto', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
