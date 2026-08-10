import daisyui from "daisyui"

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./www/**/*.{html,js,njk}"],
  theme: {
    extend: {},
  },
  plugins: [
    daisyui,
  ],
  daisyui: {
    themes: [
      {
        light: {
          ...require("daisyui/src/theming/themes")["light"],
          "primary": "#2B5F8E",
          "primary-content": "#FFFFFF",
          "neutral": "#16293B",
          "neutral-content": "#E9E6DF",
          "base-100": "#F5F5F2",
          "base-200": "#FFFFFF",
          "base-300": "#E4DFD5",
          "base-content": "#16293B",
        },
      },
      {
        dark: {
          ...require("daisyui/src/theming/themes")["night"],
          "primary": "#6FA6D8",
          "primary-content": "#14181C",
          "neutral": "#E9E6DF",
          "neutral-content": "#14181C",
          "base-100": "#14181C",
          "base-200": "#1D2329",
          "base-300": "#2A3038",
          "base-content": "#E9E6DF",
        },
      }
    ],
  },
}
