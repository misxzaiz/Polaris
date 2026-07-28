/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Catppuccin Mocha palette — 与主项目一致
        primary: "#cba6f7",
        "primary-soft": "#cba6f733",
        "background-base": "#1e1e2e",
        "background-elevated": "#181825",
        "background-surface": "#313244",
        "border": "#45475a",
        "text-primary": "#cdd6f4",
        "text-secondary": "#a6adc8",
        "text-tertiary": "#6c7086",
        "success": "#a6e3a1",
        "danger": "#f38ba8",
        "warning": "#f9e2af",
        "danger-faint": "#f38ba820",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        soft: "0 2px 8px rgba(0,0,0,0.18)",
      },
    },
  },
  darkMode: "class",
};
