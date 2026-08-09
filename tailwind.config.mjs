import daisyui from "daisyui"

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./www/**/*.{html,js,njk}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        terracotta:  { DEFAULT: '#C15A34', light: '#E0855F' },
        'vert-depot': { DEFAULT: '#2F7D5C', light: '#5FB58C' },
      },
    },
  },
  plugins: [
    daisyui,
  ],
  daisyui: {
    themes: [
      {
        light: {
          "primary":          "#2B5F8E",   // bleu d'étude
          "primary-content":  "#FFFFFF",
          "secondary":        "#C15A34",   // terracotta (échéances)
          "secondary-content":"#FFFFFF",
          "accent":           "#2F7D5C",   // vert dépôt (accès ouvert)
          "accent-content":   "#FFFFFF",
          "neutral":          "#16293B",   // encre
          "neutral-content":  "#E9E6DF",
          "base-100":         "#F7F4EE",   // papier
          "base-200":         "#FFFFFF",   // ivoire / cartes
          "base-300":         "#E4DFD5",   // grès / bordures
          "base-content":     "#16293B",   // encre
          "info":             "#2B5F8E",
          "success":          "#2F7D5C",
          "warning":          "#C15A34",
          "error":            "#C15A34",
        },
      },
      {
        dark: {
          "primary":          "#6FA6D8",   // bleu d'étude sombre
          "primary-content":  "#14181C",
          "secondary":        "#E0855F",   // terracotta sombre
          "secondary-content":"#14181C",
          "accent":           "#5FB58C",   // vert dépôt sombre
          "accent-content":   "#14181C",
          "neutral":          "#E9E6DF",   // encre sombre
          "neutral-content":  "#14181C",
          "base-100":         "#14181C",   // papier sombre
          "base-200":         "#1D2329",   // ivoire sombre / cartes
          "base-300":         "#2A3038",   // grès sombre
          "base-content":     "#E9E6DF",   // encre pâle
          "info":             "#6FA6D8",
          "success":          "#5FB58C",
          "warning":          "#E0855F",
          "error":            "#E0855F",
        },
      }
    ],
  },
}
