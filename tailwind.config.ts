import type { Config } from "tailwindcss";

/**
 * ETA design tokens — mirrors OPD v4 brand palette, adapted for mobile-first.
 * Locked from Design System (Daily Dash EHRC/ETA/Even Encounter Assistant - v1.pdf).
 *
 * Usage rules:
 * - Clinician primary actions -> even.blue.600 (hover even.blue.700)
 * - Clinician text -> even.navy.800 / even.ink.800
 * - AI suggestions + AI controls -> ai.* + sparkle (never violet elsewhere)
 * - Warnings, allergies, failed sends -> even.pink + warning
 * - Disabled / placeholder / meta -> even.ink.300 / 400 / 500
 * - Surface -> even.white (#FCFCFC). Card: ink-100 border, no shadow. Hover: shadow-card + ink-200.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        even: {
          blue: {
            50: "#EBF1FF",
            100: "#D6E3FF",
            200: "#ADC7FF",
            300: "#85ABFF",
            400: "#5C8FFF",
            500: "#3373FF",
            600: "#0055FF",
            700: "#0044CC",
            800: "#003399",
            900: "#002266",
            950: "#001133",
          },
          navy: {
            50: "#E6EBF2",
            100: "#CCD7E5",
            200: "#99B0CC",
            300: "#6688B2",
            400: "#336199",
            500: "#003B7F",
            600: "#003066",
            700: "#002A5C",
            800: "#002054",
            900: "#001640",
            950: "#000D26",
          },
          pink: {
            50: "#FEEEF6",
            100: "#FDDDED",
            200: "#FCBADC",
            300: "#FB97CA",
            400: "#FA82BD",
            500: "#F96EB1",
            600: "#F73E97",
            700: "#E81077",
            800: "#B30D5C",
            900: "#7E0941",
          },
          ink: {
            50: "#F7F8FA",
            100: "#EDEEF2",
            200: "#D6D9E0",
            300: "#B5BAC5",
            400: "#8C93A3",
            500: "#646B7A",
            600: "#454B58",
            700: "#2E323B",
            800: "#1B1E24",
            900: "#0B0D11",
          },
          white: "#FCFCFC",
          cream: "#F9F8F4",
        },
        ai: {
          50: "#F5F3FF",
          100: "#EDE9FE",
          200: "#DDD6FE",
          700: "#6D28D9",
        },
        success: { 100: "#D1FAE5", 500: "#10B981", 700: "#047857" },
        warning: { 100: "#FEF3C7", 500: "#F59E0B", 700: "#B45309" },
        danger:  { 100: "#FEE2E2", 500: "#EF4444", 700: "#B91C1C" },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["Roboto Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        display: ["28px", { lineHeight: "36px", fontWeight: "600" }],
        heading: ["18px", { lineHeight: "24px", fontWeight: "600" }],
        body: ["14px", { lineHeight: "20px", fontWeight: "400" }],
        label: ["13px", { lineHeight: "16px", fontWeight: "500" }],
        caption: ["12px", { lineHeight: "16px", fontWeight: "400" }],
        meta: ["10px", { lineHeight: "14px", fontWeight: "500" }],
      },
      borderRadius: {
        sm: "2px",
        md: "6px",
        lg: "8px",
        xl: "12px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0, 32, 84, 0.04)",
        "card-hover": "0 2px 8px rgba(0, 32, 84, 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
