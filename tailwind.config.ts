import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-nanum-square-neo)", "NanumSquare Neo", "Arial", "sans-serif"],
        serif: ["var(--font-nanum-square-neo)", "NanumSquare Neo", "Arial", "sans-serif"],
      },
      colors: {
        background: "#FAF8F3",
        surface: "#FFFFFF",
        "surface-muted": "#F3F0E8",
        ink: "#17202a",
        "ink-muted": "#667085",
        "ink-subtle": "#8A8F98",
        primary: "#1F2A44",
        court: "#7f1d1d",
        parchment: "#f7f4ec",
        rule: "#d7d0c0",
        line: "#E7E0D3",
        "line-strong": "#D7D0C0",
        gold: "#B8860B",
        mint: "#0f766e",
        archive: {
          ink: "#20242B",
          heading: "#2A3038",
          text: "#4B5563",
          muted: "#667085",
          subtle: "#6E7784",
          accent: "#243B5A",
          "accent-hover": "#172C48",
          line: "#D9DEE5",
          "line-strong": "#B8C0CB",
          surface: "#F4F6F8",
          "surface-soft": "#F8FAFC",
          tint: "#EEF2F6",
          skeleton: "#E5E7EB",
        },
      },
      boxShadow: {
        card: "0 10px 24px rgba(23, 32, 42, 0.06)",
        panel: "0 18px 42px rgba(23, 32, 42, 0.08)",
        floating: "0 24px 60px rgba(23, 32, 42, 0.12)",
        soft: "0 16px 40px rgba(23, 32, 42, 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
