// Source of truth for /tailwind.css. Rebuild after adding new utility classes
// anywhere (pages or src/**/*.js):   npm run css
// The old tailwind.css was a one-off purged snapshot, so any class not used
// back then silently rendered unstyled (e.g. the Workspace banner).
module.exports = {
  content: ['./**/*.html', './src/**/*.js', '!./node_modules/**', '!./scratch/**'],
  theme: {
    extend: {
      colors: { brand: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' } },
      fontFamily: { sans: ['Inter', 'Noto Sans Thai', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'] },
    },
  },
};
