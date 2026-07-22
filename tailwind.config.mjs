/**
 * Official ATC brand colors (confirmed hex values).
 *
 * Color philosophy: blue is always the primary color, pink secondary,
 * yellow/gold tertiary. That hierarchy also maps onto driver classes —
 * Alpha = blue, Gamma = pink, Delta = gold. Use `brand.primary` /
 * `brand.secondary` / `brand.tertiary` for anything about visual hierarchy
 * (CTAs, emphasis, accents). Use the literal `brand.blue` / `brand.pink` /
 * `brand.gold` names specifically when the color's meaning IS the driver
 * class, not just "the primary color" — e.g. DriverCard's class badges.
 * Both sets point at the same hex values, so this is purely about keeping
 * intent readable in the markup, not a real distinction to Tailwind.
 */
const brand = {
  primary: '#4369F5',
  secondary: '#F5426E',
  tertiary: '#F5C642',

  blue: '#4369F5',
  pink: '#F5426E',
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
