import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Concert-piano palette: ebony surfaces, ivory type, brass + steel accents.
        bg: "#0a0a0c",
        surface: "#141418",
        "surface-2": "#0e0e12",
        line: "#27272e",
        "line-strong": "#3a3a44",
        ink: "#f3f1ec",
        "ink-dim": "#a7a7b0",
        "ink-faint": "#71717a",
        accent: "#e6b45c",
        "accent-hi": "#f0c572",
        "accent-ink": "#0a0a0c",
        cool: "#79a9d6",
        danger: "#ef6f77",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-fraunces)", "Georgia", "Cambria", "serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 18px 40px -24px rgba(0,0,0,0.9)",
        glow: "0 10px 30px -12px rgba(230,180,92,0.5)",
      },
    },
  },
  plugins: [],
};
export default config;
