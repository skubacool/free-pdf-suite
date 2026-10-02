// Shared text helpers for the tools that re-draw a page as an image (Edit Text,
// Smart Erase, Find & Redact, PDF/A): read the real text lines off a page with
// pdf.js, and write them back onto the new page as an invisible text layer so
// the result is still selectable and searchable.
//
// Coordinates are PDF points with a TOP-LEFT origin (pdf.js viewport space at
// scale 1). Only horizontal Latin + Thai text is rebuilt; other scripts are
// left out of the layer rather than risk a 15 MB CJK font in a small file.

const THAI = /[฀-๿]/;

// Some Thai fonts (Microsoft/Linux style) return stacked tone marks and vowels
// as private-use alternates; map them back to the standard Thai characters.
const PUA = { '\uF700': '\u0E10', '\uF701': '\u0E34', '\uF702': '\u0E35', '\uF703': '\u0E36', '\uF704': '\u0E37', '\uF705': '\u0E48', '\uF706': '\u0E49', '\uF707': '\u0E4A', '\uF708': '\u0E4B', '\uF709': '\u0E4C', '\uF70A': '\u0E48', '\uF70B': '\u0E49', '\uF70C': '\u0E4A', '\uF70D': '\u0E4B', '\uF70E': '\u0E4C', '\uF70F': '\u0E0D', '\uF710': '\u0E31', '\uF711': '\u0E4D', '\uF712': '\u0E47', '\uF713': '\u0E48', '\uF714': '\u0E49', '\uF715': '\u0E4A', '\uF716': '\u0E4B', '\uF717': '\u0E4C', '\uF718': '\u0E38', '\uF719': '\u0E39', '\uF71A': '\u0E3A' };
const fixPua = (s) => s.replace(/[\uF700-\uF71A]/g, (c) => PUA[c] || c);
export const damagedCount = (s) => (String(s).match(/[\u0000\uFFFD\uE000-\uF8FF]/g) || []).length;

// ---- read lines off a pdf.js page --------------------------------------
export async function extractLines(page, { measure = false, split = false } = {}) {
  if (measure) { try { await page.getOperatorList(); await document.fonts.ready; } catch (_) {} } // makes pdf.js load this page's fonts
  const vp = page.getViewport({ scale: 1 });
  // split: keep every text chunk separate (pdf.js otherwise glues chunks on one
  // line into one item, hiding table column gaps); words are re-joined below by gap
  const tc = await page.getTextContent(split ? { disableCombineTextItems: true } : {});
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.length) continue;
    if (split && !it.str.trim()) continue; // pdf.js adds whitespace items that span column gaps; real gaps are measured instead
    const t = window.pdfjsLib.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]);
    if (!size || Math.abs(t[1]) > 0.02 * Math.abs(t[0])) continue; // skip rotated runs
    const style = tc.styles[it.fontName] || {};
    items.push({ str: fixPua(it.str), x: t[4], base: t[5], w: it.width, size, fontName: it.fontName, family: style.fontFamily });
  }
  const lines = [];
  let cur = null;
  const startLine = (it) => ({ ...it, runs: [{ str: it.str, x: it.x, w: it.w, start: 0 }] });
  for (const it of items) {
    const gap = cur ? it.x - (cur.x + cur.w) : 0;
    if (cur && Math.abs(it.base - cur.base) < 0.25 * cur.size && gap < 0.4 * cur.size && gap > -0.6 * cur.size && Math.abs(it.size - cur.size) < 0.18 * cur.size && it.fontName === cur.fontName) {
      const space = split && gap > cur.size * 0.12 && !/\s$/.test(cur.str) && !/^\s/.test(it.str) && !(THAI.test(cur.str.slice(-1)) && THAI.test(it.str[0]) && gap < cur.size * 0.15);
      if (space) { cur.runs.push({ str: ' ', x: cur.x + cur.w, w: gap, start: cur.str.length }); cur.str += ' '; }
      cur.runs.push({ str: it.str, x: it.x, w: it.w, start: cur.str.length });
      cur.str += it.str;
      cur.w = it.x + it.w - cur.x;
    } else {
      if (cur) lines.push(cur);
      cur = startLine(it);
    }
  }
  if (cur) lines.push(cur);
  const kept = lines.filter((l) => l.str.trim());
  if (measure) {
    // Exact character positions: measure prefixes of each run in the PDF's own
    // (subset) font, as loaded by pdf.js, instead of assuming equal-width letters.
    const g = document.createElement('canvas').getContext('2d');
    kept.forEach((l) => {
      g.font = `100px "${l.fontName}", sans-serif`;
      l.runs.forEach((r) => {
        const n = r.str.length;
        const full = g.measureText(r.str).width;
        if (!n || !full) return;
        r.frac = [0];
        for (let i = 1; i <= n; i++) r.frac.push(Math.min(1, g.measureText(r.str.slice(0, i)).width / full));
      });
    });
  }
  return { width: vp.width, height: vp.height, lines: kept };
}

// Box (top-left origin, points) of characters [from, to) of a line, using each
// run's own x/width and spreading characters evenly inside a run.
export function rangeBox(line, from, to) {
  let x0 = Infinity, x1 = -Infinity;
  for (const r of line.runs) {
    const a = Math.max(from, r.start), b = Math.min(to, r.start + r.str.length);
    if (b <= a) continue;
    const per = r.w / Math.max(1, r.str.length);
    const at = (i) => (r.frac ? r.x + r.w * r.frac[i - r.start] : r.x + (i - r.start) * per);
    x0 = Math.min(x0, at(a));
    x1 = Math.max(x1, at(b));
  }
  if (!isFinite(x0)) return null;
  return { x: x0, w: x1 - x0, top: line.base - line.size * 0.95, h: line.size * 1.3 };
}

export const lineBox = (l) => ({ x: l.x, w: l.w, top: l.base - l.size * 0.95, h: l.size * 1.3 });
export const boxesOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.top < b.top + b.h && b.top < a.top + a.h;

// ---- write an invisible text layer ------------------------------------
const fontCache = new WeakMap(); // pdf-lib doc -> { thai, latin }

async function fonts(doc, latinEmbedded) {
  const { PDFLib, getUnicodeFont } = window.appHelpers;
  let c = fontCache.get(doc);
  if (!c) { c = {}; fontCache.set(doc, c); }
  if (!c.thai) c.thai = null; // resolved lazily
  return {
    async thai() { return c.thai || (c.thai = await getUnicodeFont(doc, 'ก')); },
    async latin() {
      if (latinEmbedded) return c.latinE || (c.latinE = await getUnicodeFont(doc, 'A'));
      return c.latin || (c.latin = await doc.embedFont(PDFLib.StandardFonts.Helvetica));
    },
  };
}

const toLatin = (s) => s.replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[\t ]/g, ' ').replace(/[^\x20-\x7E\xA1-\xFF]/g, '');

// lines: [{ text, x, base, w, size }] in top-left points. pageH = page height.
export async function addTextLayer(doc, page, pageH, lines, { latinEmbedded = false } = {}) {
  const { PDFLib } = window.appHelpers;
  const { PDFOperator, PDFNumber, setTextRenderingMode, TextRenderingMode } = PDFLib;
  const F = await fonts(doc, latinEmbedded);
  let drawn = 0;
  page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
  for (const ln of lines) {
    const text = String(ln.text || '');
    if (!text.trim()) continue;
    // split into Thai / Latin chunks (spaces stay with the chunk before them)
    const chunks = [];
    for (const ch of text) {
      const kind = THAI.test(ch) ? 'thai' : (ch === ' ' && chunks.length ? chunks[chunks.length - 1].kind : 'latin');
      if (chunks.length && chunks[chunks.length - 1].kind === kind) chunks[chunks.length - 1].s += ch;
      else chunks.push({ kind, s: ch });
    }
    const parts = [];
    for (const c of chunks) {
      // SARA AM (U+0E33) is split into two glyphs by the font and extracts as a
      // stray extra letter; its compatibility form U+0E4D U+0E32 extracts cleanly.
      const s = c.kind === 'thai' ? c.s.replace(/ำ/g, 'ํา') : toLatin(c.s);
      if (!s) continue;
      try {
        const font = c.kind === 'thai' ? await F.thai() : await F.latin();
        parts.push({ s, font, nat: font.widthOfTextAtSize(s, ln.size) });
      } catch (_) { /* a glyph the font cannot encode: leave that chunk out */ }
    }
    const natural = parts.reduce((a, p) => a + p.nat, 0);
    if (!parts.length || !natural) continue;
    const pct = Math.min(250, Math.max(40, (ln.w / natural) * 100));
    page.pushOperators(PDFOperator.of('Tz', [PDFNumber.of(pct)]));
    let x = ln.x;
    for (const p of parts) {
      try { page.drawText(p.s, { x, y: pageH - ln.base, size: ln.size, font: p.font }); drawn++; } catch (_) {}
      x += p.nat * (pct / 100);
    }
  }
  page.pushOperators(PDFOperator.of('Tz', [PDFNumber.of(100)]));
  page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
  return drawn;
}
