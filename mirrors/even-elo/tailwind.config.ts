import type { Config } from "tailwindcss";

/**
 * Even-ELO design tokens
 * Locked at PRD v1.1 / mockup spec EVEN-ELO-MOCKUPS.html
 * Do not change without updating the mockup file first (see PRD §3.1 / D35).
 */
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        // Brand
        brand: {
          DEFAULT: "#0f766e",
          hover: "#115e59",
          soft: "#ccfbf1",
          softer: "#f0fdfa",
        },
        // Tier palette — used in chips, bars, score colours, threshold lines
        tier: {
          "dist-bg": "#dcfce7",
          "dist-text": "#14532d",
          "dist-bar": "#16a34a",
          "std-bg": "#dbeafe",
          "std-text": "#1e40af",
          "std-bar": "#2563eb",
          "watch-bg": "#fef3c7",
          "watch-text": "#92400e",
          "watch-bar": "#d97706",
          "pip-bg": "#ffedd5",
          "pip-text": "#9a3412",
          "pip-bar": "#ea580c",
          "susp-bg": "#fee2e2",
          "susp-text": "#991b1b",
          "susp-bar": "#dc2626",
          "none-bg": "#f4f4f5",
          "none-text": "#52525b",
          "none-bar": "#71717a",
        },
      },
      letterSpacing: {
        score: "-0.04em",
      },
    },
  },
  plugins: [],
};
export default config;
