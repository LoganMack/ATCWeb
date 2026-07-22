/**
 * Official ATC brand colors (confirmed hex values).
 */
const brand = {
  pink: '#F5426E',
  blue: '#4369F5',
  gold: '#F5C642',
  ink: '#0B0B0E',    // near-black background — not an official brand color, just this site's dark canvas
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
        // `display` is for headlines/titles/numbers. Using Teko (open-source,
        // condensed/technical, same family of feel as Cuatra/Bison/Russo One)
        // as the primary choice for now — see the licensing note in
        // src/layouts/Layout.astro and the README for why. Prepend 'Cuatra'
        // here (and self-host its files) if you secure a commercial license.
        display: ['Teko', 'Russo One', 'system-ui', 'sans-serif'],
        // `body` is regular text — Roboto per your existing brand.
        body: ['Roboto', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
