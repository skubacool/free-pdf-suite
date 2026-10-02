// Writes one edited line of text onto an output page as REAL PDF text (vector,
// selectable), in the best available copy of the original typeface:
//   1. a full font file the user supplied for this font, or
//   2. the font embedded in the PDF itself (exact glyphs for every character the
//      document already uses), and
//   3. for any character the embedded subset lacks, the closest matching font,
//      chosen by comparing glyph widths with the original and scaled to match.
// Used by Edit PDF Text for both the downloaded file and the live preview.
import { EmbFont, copyFontInto } from './embeddedfont.js';
import { parseFontName, googleFontBytes } from './fontmatch.js';

const THAI = /[฀-๿]/;
const THAI_CANDIDATES = ['Sarabun', 'Noto Sans Thai', 'Prompt', 'Kanit', 'IBM Plex Sans Thai', 'Anuphan', 'Niramit', 'K2D', 'Krub'];
const THAI_FAMILIES = new Set([...THAI_CANDIDATES, 'Noto Serif Thai', 'Mitr', 'Athiti', 'Pridi', 'Trirong']);
const LATIN_CANDIDATES = ['Arimo', 'Noto Sans', 'Inter', 'Roboto', 'Open Sans'];
const NAMED = { arial: 'Arimo', arialmt: 'Arimo', helvetica: 'Arimo', 'times new roman': 'Tinos', times: 'Tinos', 'courier new': 'Cousine', courier: 'Cousine', calibri: 'Noto Sans', verdana: 'Noto Sans', tahoma: 'Noto Sans' };
const GENERIC = { sans: { latin: 'Arimo', thai: 'Noto Sans Thai' }, serif: { latin: 'Tinos', thai: 'Noto Serif Thai' }, mono: { latin: 'Cousine', thai: 'Noto Sans Thai' } };

const bytesCache = new Map();
async function bytesFor(family, bold) {
  const key = `${family}|${bold ? 700 : 400}`;
  if (!bytesCache.has(key)) bytesCache.set(key, googleFontBytes(family, bold ? 700 : 400, false));
  return bytesCache.get(key);
}

const fkCache = new Map();
async function fkFor(family, bold) {
  const key = `${family}|${bold ? 700 : 400}`;
  if (!fkCache.has(key)) {
    fkCache.set(key, (async () => {
      const bytes = await bytesFor(family, bold);
      return bytes ? window.fontkit.create(new Uint8Array(bytes)) : null;
    })());
  }
  return fkCache.get(key);
}

// ---- per-output-document context ---------------------------------------
export function makeContext(out) {
  out.registerFontkit(window.fontkit);
  return { out, copied: new Map(), subs: new Map(), pick: new Map() };
}

async function helvetica(ctx) {
  if (!ctx.helv) ctx.helv = await ctx.out.embedFont(window.PDFLib.StandardFonts.Helvetica);
  return ctx.helv;
}

async function subFont(ctx, family, bold) {
  const key = `${family}|${bold}`;
  if (ctx.subs.has(key)) return ctx.subs.get(key);
  const bytes = await bytesFor(family, bold);
  if (!bytes) { ctx.subs.set(key, null); return null; }
  const fk = window.fontkit.create(new Uint8Array(bytes));
  // pdf-lib's subsetter renders some Latin fonts blank, so Latin fonts are embedded whole; Thai fonts subset fine
  const thaiFont = THAI_FAMILIES.has(family);
  const font = await ctx.out.embedFont(bytes, { subset: thaiFont });
  const o = { font, fk, family };
  ctx.subs.set(key, o);
  return o;
}
async function userFont(ctx, bytes, key) {
  if (ctx.subs.has(key)) return ctx.subs.get(key);
  const fk = window.fontkit.create(new Uint8Array(bytes));
  const font = await ctx.out.embedFont(bytes, { subset: bytes.byteLength > 300000 });
  const o = { font, fk, family: 'your font' };
  ctx.subs.set(key, o);
  return o;
}

// choose the candidate whose glyph widths best match the embedded font, and the
// size factor that lines the widths up
async function bestSub(ctx, emb, script, bold) {
  const key = `${emb.rawName}|${script}|${bold}`;
  if (ctx.pick.has(key)) return ctx.pick.get(key);
  const sample = [];
  emb.uni2codes.forEach((codes, cp) => {
    const isThai = cp >= 0x0E01 && cp <= 0x0E3A;
    const isLatin = (cp >= 0x41 && cp <= 0x7A) || (cp >= 0x30 && cp <= 0x39);
    if ((script === 'thai' && isThai) || (script === 'latin' && isLatin)) { const c = codes.find((q) => emb.hasInk(q, cp)); if (c != null) sample.push([cp, emb.widthOf(c) / 1000]); }
  });
  let best = null;
  for (const family of script === 'thai' ? THAI_CANDIDATES : LATIN_CANDIDATES) {
    let fk;
    try { fk = await fkFor(family, bold); } catch (_) { fk = null; }
    if (!fk) continue; // measured only: nothing is embedded unless it wins
    const up = fk.unitsPerEm;
    const ratios = [], diffs = [];
    sample.slice(0, 80).forEach(([cp, w]) => {
      const g = fk.glyphForCodePoint(cp);
      if (!g || !g.id) return;
      const sw = g.advanceWidth / up;
      if (sw > 0 && w > 0) { ratios.push(w / sw); diffs.push(Math.abs(w - sw) / Math.max(w, sw)); }
    });
    if (ratios.length < 4) continue;
    ratios.sort((a, b) => a - b);
    const med = ratios[ratios.length >> 1];
    const score = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (!best || score < best.score) best = { family, scale: Math.min(1.2, Math.max(0.8, med)), score };
  }
  const family = best ? best.family : script === 'thai' ? 'Noto Sans Thai' : 'Arimo';
  const res = { sf: await subFont(ctx, family, bold), scale: best ? best.scale : 1, score: best ? best.score : 1 };
  ctx.pick.set(key, res);
  return res;
}

// font to use for characters the original does not cover / when there is no embedded font
async function substitute(ctx, emb, rawName, family, script, bold) {
  if (family && family !== 'orig') return { sf: await subFont(ctx, GENERIC[family][script], bold), scale: 1 };
  if (emb) return bestSub(ctx, emb, script, bold);
  const p = parseFontName(rawName);
  const named = NAMED[p.family.toLowerCase()];
  if (named && script === 'latin') return { sf: await subFont(ctx, named, bold), scale: 1 };
  if (script === 'thai') return { sf: await subFont(ctx, p.family.replace(/\s+/g, ' ') === 'Sarabun' ? 'Sarabun' : 'Sarabun', bold), scale: 1 };
  return { sf: await subFont(ctx, named || 'Noto Sans', bold), scale: 1 };
}

const scriptOf = (ch) => (THAI.test(ch) ? 'thai' : 'latin');

// ---- the writer ---------------------------------------------------------
// opts: { text, size, base (top-left y of the baseline), x0, x1 (original box), align,
//         color:[r,g,b] 0..1, emb, rawName, userBytes, family, bold, forceSub, pageH }
// planLine measures and decides fonts; emitLine writes it. Both return the plan.
export async function planLine(ctx, opts) {
  const { text, size, emb } = opts;
  const bold = !!opts.bold;
  const orig = !opts.family || opts.family === 'orig';
  const runs = [];
  const missing = [];
  const dropped = [];
  let usedFont = '';
  let fromFile = false;
  const chunkByScript = (str) => {
    const chunks = [];
    for (const ch of str) { const k = scriptOf(ch); const l = chunks[chunks.length - 1]; if (l && l.k === k) l.s += ch; else chunks.push({ k, s: ch }); }
    return chunks;
  };
  const addSub = async (str) => {
    for (const ck of chunkByScript(str)) {
      let { sf, scale } = await substitute(ctx, emb, opts.rawName, opts.family, ck.k, bold);
      if (!sf && ck.k === 'latin') { // offline: the built-in Helvetica still draws every English letter and digit
        const hv = await helvetica(ctx);
        const t = ck.s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^ -~¡-ÿ]/g, '?');
        // line the built-in font up with the original's glyph widths so sizes still look consistent
        let hs = 1;
        if (emb) {
          const ratios = [];
          emb.uni2codes.forEach((codes, cp) => {
            if (!((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || (cp >= 0x30 && cp <= 0x39))) return;
            const c = codes.find((q) => emb.hasInk(q, cp));
            const hw = hv.widthOfTextAtSize(String.fromCodePoint(cp), 1);
            if (c != null && hw > 0) ratios.push(emb.widthOf(c) / 1000 / hw);
          });
          ratios.sort((a, b) => a - b);
          if (ratios.length >= 4) hs = Math.min(1.2, Math.max(0.8, ratios[ratios.length >> 1]));
        }
        runs.push({ kind: 'sub', text: t, sf: { font: hv, family: 'Helvetica' }, scale: hs, width: hv.widthOfTextAtSize(t, size * hs) });
        dropped.push('(offline: used Helvetica)');
        continue;
      }
      if (!sf) { for (const ch of ck.s) dropped.push(ch); continue; } // no matching font could be loaded
      const t = ck.k === 'thai' ? ck.s.replace(/ำ/g, 'ํา') : ck.s; // SARA AM as NIKHAHIT + SARA AA extracts cleanly
      runs.push({ kind: 'sub', text: t, sf, scale, width: sf.font.widthOfTextAtSize(t, size * scale) });
    }
  };

  if (opts.userBytes && orig && !opts.forceSub) {
    const uf = await userFont(ctx, opts.userBytes, `user|${opts.userKey || opts.rawName}`);
    runs.push({ kind: 'sub', text, sf: uf, scale: 1, width: uf.font.widthOfTextAtSize(text, size) });
    usedFont = opts.userLabel || 'your font file';
    fromFile = true;
  } else if (emb && orig && !opts.forceSub) {
    const parts = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const has = emb.has(cp) || (cp === 0x0E33 && emb.has(0x0E4D) && emb.has(0x0E32));
      const last = parts[parts.length - 1];
      if (last && last.has === has) last.s += ch; else parts.push({ has, s: ch });
    }
    for (const part of parts) {
      if (part.has) {
        const c = emb.compose(part.s, size);
        runs.push({ kind: 'emb', hex: c.hex, width: c.width });
        c.missing.forEach((m) => missing.push(m));
      } else {
        for (const ch of part.s) missing.push(ch);
        await addSub(part.s);
      }
    }
    usedFont = emb.name;
  } else {
    await addSub(text);
    usedFont = runs[0] && runs[0].sf ? runs[0].sf.family : '';
  }
  const total = runs.reduce((a, r) => a + r.width, 0);
  const x = opts.align === 'right' ? opts.x1 - total : opts.align === 'center' ? (opts.x0 + opts.x1) / 2 - total / 2 : opts.x0;
  return { runs, width: total, x, missing: [...new Set(missing)], dropped: [...new Set(dropped)], usedFont, fromFile, opts, emb };
}

export function emitLine(ctx, outPage, plan) {
  const { PDFHexString, beginText, endText, setFontAndSize, moveText, showText, pushGraphicsState, popGraphicsState, setFillingRgbColor, rgb } = window.PDFLib;
  const { opts, emb } = plan;
  const y = opts.pageH - opts.base;
  const [cr, cg, cb] = opts.color || [0, 0, 0];
  let pen = plan.x;
  for (const r of plan.runs) {
    if (r.kind === 'emb') {
      let ref = ctx.copied.get(emb);
      if (!ref) { ref = copyFontInto(ctx.out, emb); ctx.copied.set(emb, ref); }
      const tag = outPage.node.newFontDictionary(`UPMF${ctx.copied.size}`, ref);
      outPage.pushOperators(
        pushGraphicsState(), setFillingRgbColor(cr, cg, cb), beginText(), setFontAndSize(tag, opts.size), moveText(pen, y),
        showText(PDFHexString.of(r.hex)), endText(), popGraphicsState(),
      );
    } else {
      outPage.drawText(r.text, { x: pen, y, size: opts.size * r.scale, font: r.sf.font, color: rgb(cr, cg, cb) });
    }
    pen += r.width;
  }
}
