/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#f4f6fa",
        surface: "#ffffff",
        "surface-muted": "#f8fafc",
        "surface-container": "#eef2f6",
        primary: "#4f46e5",
        "primary-hover": "#4338ca",
        "primary-light": "#e0e7ff",
        secondary: "#6366f1",
        "on-surface": "#0f172a",
        "on-surface-variant": "#475569",
        "on-primary": "#ffffff",
        accent: "#7c3aed",
        border: "rgba(15, 23, 42, 0.08)",
        "border-focus": "#4f46e5",
        outline: "#94a3b8",
        success: "#10b981",
        "success-light": "#ecfdf5",
        warning: "#f59e0b",
        "warning-light": "#fffbeb",
        error: "#ef4444",
        "error-light": "#fef2f2",
      },
      boxShadow: {
        soft: "0 4px 20px -2px rgba(15, 23, 42, 0.05)",
        medium: "0 8px 30px -4px rgba(15, 23, 42, 0.08)",
        premium: "0 12px 40px -6px rgba(79, 70, 229, 0.12)",
      },
      fontFamily: {
        sans: ["Nunito", "sans-serif"],
      },
    },
  },
  plugins: [],
};
