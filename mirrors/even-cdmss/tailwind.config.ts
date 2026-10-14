import type { Config } from 'tailwindcss';

// ── CAT design system: "Clarity" (calm light editorial) ──────────────────────
// Bolder refresh chosen 29 Jun 2026. Warm-neutral canvas + deep-teal accent +
// serif display. We REMAP two heavily-used Tailwind color names so the whole app
// adopts the new identity with low churn:
//   • `slate`  → a warm-neutral ramp (lightness-matched to Tailwind slate so
//                contrast is preserved; only the hue warms). All existing
//                text-slate-*/border-slate-* usages become warm automatically.
//   • `brand`  → deep teal (the Clarity accent). All text-brand/bg-brand-faint
//                usages become teal automatically.
// Semantic colors (emerald/amber/red/sky) are left to Tailwind defaults.

const warm = {
  50:  '#f8f7f4',
  100: '#f1efe9',
  200: '#e7e3d9',
  300: '#d4cfc1',
  400: '#a8a08f',
  500: '#78715f',
  600: '#595346',
  700: '#403b31',
  800: '#292620',
  900: '#1a1712',
};

const teal = {
  faint:   '#e9f4f1',
  light:   '#2f9e8c',
  DEFAULT: '#0f766e',
  dark:    '#0b5f58',
  deep:    '#0a3f3a',
};

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm-neutral ramp (replaces cool slate app-wide)
        slate: warm,
        // Clarity accent (deep teal) — replaces the old Even blue `brand`
        brand: { DEFAULT: teal.DEFAULT, dark: teal.dark, light: teal.light, faint: teal.faint, deep: teal.deep },
        accent: teal,
        // Warm semantic surface aliases for new components
        paper:  '#ffffff',
        canvas: '#f8f7f4',
        line:   '#e7e3d9',
        ink:    { DEFAULT: '#1a1712', soft: '#595346', muted: '#78715f' },
        // Retained brand colors (still referenced in a few places)
        navy:   { DEFAULT: '#0a3f3a', dark: '#072d29' },
        pink:   { DEFAULT: '#c2603f', light: '#f6ece4', dark: '#9a4827' },
        off:    '#ffffff',
      },
      fontFamily: {
        sans:  ['var(--font-inter)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-serif)', 'Georgia', 'Cambria', 'serif'],
      },
      borderRadius: {
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(26,23,18,0.04), 0 6px 20px rgba(26,23,18,0.05)',
        pop:  '0 8px 30px rgba(26,23,18,0.10)',
      },
      maxWidth: {
        content: '880px',
      },
    },
  },
  plugins: [],
};
export default config;
