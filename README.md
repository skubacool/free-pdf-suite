# Free PDF Suite

**Live site:** https://skubacool.github.io/free-pdf-suite/

A free, ad-monetized, 100% client-side PDF utility suite aimed at office workers,
students and clerks. All processing runs in the visitor's browser — zero server
cost, no upload latency, and total privacy ("Files Never Leave Your Device").

## Tools (14)

| Tool | How it works |
|---|---|
| 🗂️ Merge PDF | `pdf-lib` copies pages from every source into one document |
| ✂️ Split PDF | Page-range parser (`1-3, 5`) → extract or remove pages via `pdf-lib` |
| 🔄 Rotate PDF | `pdf-lib` `setRotation` on all pages or a chosen range |
| 🗜️ Compress PDF | `pdfjs-dist` re-renders pages → optimized JPEG → `pdf-lib` rebuild |
| 🔓 Unlock PDF | `pdfjs-dist` decrypts locally with the user's password, rebuilds an unlocked copy |
| 🔐 Protect PDF | Lazily loads the `@cantoo/pdf-lib` fork for AES encryption (global swapped back) |
| ✍️ Sign PDF | Canvas signature pad → PNG embedded via `pdf-lib` at a click-placed position |
| ⌨️ Type on PDF | Click-to-place text overlay baked in with `pdf-lib`; Thai via Noto Sans Thai |
| 🔢 Add Page Numbers | `pdf-lib` stamps numbers (position/format options) on every page |
| 💧 Watermark PDF | Diagonal text, auto-sized to the page diagonal, adjustable opacity |
| 📝 Word to PDF | `mammoth.js` (docx → HTML) → typographic layout via `pdf-lib`; Thai supported |
| 📃 PDF to Word | `pdfjs-dist` text extraction → Word-compatible `.doc` |
| 🖼️ JPG to PDF | `pdf-lib` `embedJpg`/`embedPng`, A4-centered or fit-to-image pages |
| 📸 PDF to JPG | `pdfjs-dist` renders pages → JPEG; multi-page output zipped with JSZip |

**Thai text support:** when text contains Thai characters, Noto Sans Thai is
fetched once from CDN and embedded via `@pdf-lib/fontkit` (subset on save).

## Design

Task-first layout for non-technical audiences: a card grid grouped by job
(Organize / Convert / Edit & Sign / Optimize & Secure), a 1-2-3 "how it works"
strip, a professional white/blue palette (Inter typeface), and a prominent
green privacy badge. Tools open in a focused view with an "← All tools"
breadcrumb; deep links like `#split` route directly to a tool.

## Architecture

- **Frontend:** single-page `index.html` + `app.js` (vanilla JS), Tailwind CSS via CDN,
  relative asset paths (`./app.js`) so it deploys to any static host — GitHub Pages ready.
- **Processing libraries (CDN):** `pdf-lib@1.17.1`, `pdfjs-dist@3.11.174`, `mammoth@1.6.0`,
  `jszip@3.10.1`, `@pdf-lib/fontkit@1.1.1`; `@cantoo/pdf-lib` loaded on demand for encryption.
- **Backend (optional, dormant):** Nhost SDK wired in [`nhost.js`](nhost.js); see
  [`nhost/README.md`](nhost/README.md) to enable Auth/Postgres/Storage later.
- **Monetization:** 18 semantic `<!-- ADVERTISEMENT SLOT -->` placeholders — header
  (728×90), native in-feed card in the tool grid, home strip, tool-view right rail
  (300×600), and beneath every Download button (336×280). Replace them with your
  AdSense/ad-network tags; fill only 3–4 per page view.
- **SEO:** meta/OG tags, canonical URL, `robots.txt`, `sitemap.xml`, and JSON-LD
  (`WebApplication` + `FAQPage`) matching the on-page FAQ.

## Local development

No build step. Open `index.html` directly, or serve the folder:

```bash
npx serve .
```

## Deployment

Hosted on GitHub Pages from the `main` branch root. Push to `main` and Pages
redeploys automatically.
