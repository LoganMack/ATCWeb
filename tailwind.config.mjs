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

  ink: '#0B0B0E', // near-black background — not an official brand color, just this site's dark canvas
};

// Theme colours. `white` (the foreground) and `brand.ink` (the canvas) read CSS variables
// that global.css sets on :root (dark) and redefines under .light, so every utility built from
// them follows the theme. Text colours that light mode darkens read their own variables.
// The fixed family never changes with the theme: use it where a colour must stay the same in
// both themes (the Nav marquee strip, white text on a solid blue badge, hover states that stay
// white).
const themed = (variable) => `rgb(var(${variable}) / <alpha-value>)`;
const fixedBrand = {
  primary: brand.primary,
  secondary: brand.secondary,
  tertiary: brand.tertiary,
  blue: brand.blue,
  pink: brand.pink,
  gold: brand.gold,
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        brand: { ...brand, ink: themed('--canvas'), fixed: fixedBrand },
        white: themed('--fg'),
        'fixed-white': '#fff',
        'fixed-ink': brand.ink,
      },
      // Light mode lifts grey text by --fg-text-boost (0.08) so it stays readable on paper.
      textColor: {
        white: 'rgb(var(--fg) / min(1, calc(<alpha-value> + var(--fg-text-boost))))',
        brand: {
          blue: themed('--text-blue'),
          primary: themed('--text-blue'),
          pink: themed('--text-pink'),
          gold: themed('--text-gold'),
        },
        emerald: { 400: themed('--text-emerald-400') },
        red: { 300: themed('--text-red-300') },
      },
      // Site-wide corner style: "slightly rounded". Every rounded-* utility in
      // the markup resolves through this scale, so changing the whole site's
      // corners (e.g. back to rounder or fully square) is a one-place edit.
      // `rounded-full` is left alone on purpose: it's only used for things
      // that must stay circular (progress bars, the avatar photo, the Posted
      // switch, the car-logo "+" badge).
      borderRadius: {
        sm: '2px',
        DEFAULT: '3px',
        md: '3px',
        lg: '3px',
        xl: '4px',
        '2xl': '4px',
        '3xl': '4px',
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
      // Nav.astro's "Happening Now" banner: content is rendered twice back
      // to back, then this scrolls the pair left by exactly half its own
      // width — since both copies are identical, the moment the first one
      // fully exits, the second is sitting exactly where the first started,
      // so the loop is seamless regardless of how long the text is (a
      // percentage, not a fixed pixel distance). Disabled entirely under
      // prefers-reduced-motion — see src/styles/global.css.
      keyframes: {
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        // 112s = the original 28s at 1/4 speed (a 75% cut), per Logan.
        marquee: 'marquee 112s linear infinite',
      },
    },
  },
  plugins: [],
};
