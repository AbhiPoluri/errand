import type { Config } from "tailwindcss";

// Warm editorial palette (PLAN.md §2, revised): paper + ink + clay/terracotta. Neutrals
// use Tailwind's warm `stone`. Status colors stay a learned vocabulary:
// clay = primary/working, ochre = needs-your-okay, forest = done, brick = a snag.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      colors: {
        paper: "#F4EFE6",
        accent: {
          // clay / terracotta
          50: "#FBF0E9",
          100: "#F4DDCE",
          400: "#D98A5E",
          600: "#C2552E",
          700: "#A8451F",
          800: "#8A3819",
        },
        forest: { 50: "#EBF1ED", 500: "#5C9069", 600: "#4D7C5A", 700: "#3E6549" },
        ochre: { 50: "#F8EFD9", 200: "#EAD3A0", 300: "#DCBC74", 400: "#CDA24A", 500: "#BE9234", 600: "#B8862B", 700: "#976D1F" },
        brick: { 50: "#F7E7E5", 200: "#E8B9B5", 300: "#DB9A95", 600: "#B4413B", 700: "#933430" },
      },
    },
  },
  plugins: [],
};

export default config;
