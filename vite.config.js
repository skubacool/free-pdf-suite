import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: '.',
    emptyOutDir: false, // DO NOT clean root dir!
    lib: {
      entry: resolve(__dirname, 'src/main.js'),
      name: 'App',
      formats: ['iife'],
      fileName: () => 'app.js'
    },
    rollupOptions: {
      // Keep CDN dependencies external so they are not bundled into app.js
      external: ['pdfLib', 'pdfjsLib', 'mammoth', 'JSZip', 'fontkit', 'marked'],
      output: {
        globals: {
          pdfLib: 'PDFLib',
          pdfjsLib: 'pdfjsLib',
          mammoth: 'mammoth',
          JSZip: 'JSZip',
          fontkit: 'fontkit',
          marked: 'marked'
        },
        extend: true
      }
    },
    minify: 'terser',
    sourcemap: false
  }
});
