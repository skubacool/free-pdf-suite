// Reuse the fonts that are embedded INSIDE a PDF to write new text in exactly the
// same typeface. A PDF normally embeds only a subset of each font (the glyphs the
// document uses), so this works for every character the document already
// contains; anything else is reported as `missing` so the caller can supply a
// substitute (or a full font file chosen by the user).
//
// What it reads from the PDF, per font: the font program (FontFile2/3), the
// ToUnicode CMap (character -> glyph code), the width table, and the font dict
// itself so it can be copied into the edited file and used with plain PDF text
// operators. Type0/Identity-H (CID TrueType) and simple TrueType/WinAnsi fonts
// are supported.
const THAI_ABOVE = new Set([0x0E31, 0x0E34, 0x0E35, 0x0E36, 0x0E37, 0x0E47, 0x0E48, 0x0E49, 0x0E4A, 0x0E4B, 0x0E4C, 0x0E4D, 0x0E4E]);
const THAI_BELOW = new Set([0x0E38, 0x0E39, 0x0E3A]);
const WIN1252 = { 0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178 };

const hexToCp = (h) => {
  // UTF-16BE hex -> array of code points
  const out = [];
  for (let i = 0; i < h.length; i += 4) {
    let u = parseInt(h.slice(i, i + 4), 16);
    if (u >= 0xD800 && u < 0xDC00 && i + 8 <= h.length) { const lo = parseInt(h.slice(i + 4, i + 8), 16); u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00); i += 4; }
    out.push(u);
  }
  return out;
};

function parseToUnicode(text) {
  const map = new Map(); // code -> [cp...]
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  let m;
  while ((m = bfchar.exec(text))) {
    for (const r of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(r[1], 16), hexToCp(r[2]));
  }
  while ((m = bfrange.exec(text))) {
    for (const r of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
      if (r[3][0] === '[') {
        const items = [...r[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, hexToCp(items[c - lo]));
      } else {
        const base = hexToCp(r[3].slice(1, -1));
        for (let c = lo; c <= hi; c++) map.set(c, [base[0] + (c - lo), ...base.slice(1)]);
      }
    }
  }
  return map;
}

export class EmbFont {
  constructor(o) { Object.assign(this, o); }
  // glyph for a code
  glyph(code) { try { return this.fk.getGlyph(this.kind === 'cid' ? code : this.simpleGid(code)); } catch (_) { return null; } }
  simpleGid(code) {
    const cps = this.codeToUni.get(code);
    return cps ? this.fk.glyphForCodePoint(cps[0]).id : 0;
  }
  widthOf(code) { // thousandths of an em
    const w = this.widths.get(code);
    return w != null ? w : this.defaultWidth;
  }
  hasInk(code, cp) {
    const g = this.glyph(code);
    if (!g) return false;
    if (cp === 0x20 || cp === 0xA0 || cp === 0x200B) return true;
    try { return g.path.commands.length > 0 || g.bbox.maxX > g.bbox.minX; } catch (_) { return true; }
  }
  has(cp) {
    const codes = this.uni2codes.get(cp);
    return !!(codes && codes.some((c) => this.hasInk(c, cp)));
  }
  // Pick the glyph variant of a combining Thai mark that best fits the cluster so
  // far (fonts keep several: raised over a vowel, shifted left over a tall letter...)
  pickVariant(cp, codes, cluster) {
    if (codes.length === 1 || !cluster || !cluster.base) return codes[0];
    const up = this.upem;
    const above = THAI_ABOVE.has(cp), below = THAI_BELOW.has(cp);
    if (!above && !below) return codes[0];
    const target = above ? cluster.top + 0.04 * up : cluster.bottom - 0.04 * up;
    const baseMid = cluster.baseMid;
    let best = codes[0], bs = Infinity;
    codes.forEach((c) => {
      const g = this.glyph(c);
      if (!g || !g.bbox) return;
      const bb = g.bbox;
      const cx = (bb.minX + bb.maxX) / 2;
      const v = above ? Math.abs(bb.minY - target) : Math.abs(bb.maxY - target);
      const s = v + 0.7 * Math.abs(cx - baseMid);
      if (s < bs) { bs = s; best = c; }
    });
    return best;
  }
  // text -> { hex, width (pt), missing: [chars], codes: [code] }
  compose(text, size) {
    let cps = [...String(text)].map((c) => c.codePointAt(0));
    // SARA AM is stored as NIKHAHIT + SARA AA; a tone mark typed before it goes above the nikhahit
    const expanded = [];
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      if (cp === 0x0E33 && !this.has(0x0E33)) {
        const prev = expanded[expanded.length - 1];
        if (prev >= 0x0E48 && prev <= 0x0E4B) { expanded.pop(); expanded.push(0x0E4D, prev, 0x0E32); } else expanded.push(0x0E4D, 0x0E32);
      } else expanded.push(cp);
    }
    cps = expanded;
    const codes = [], missing = [];
    let cluster = null;
    let width = 0;
    const up = this.upem;
    cps.forEach((cp) => {
      const cands = (this.uni2codes.get(cp) || []).filter((c) => this.hasInk(c, cp));
      if (!cands.length) { missing.push(String.fromCodePoint(cp)); cluster = null; return; }
      const isMark = THAI_ABOVE.has(cp) || THAI_BELOW.has(cp);
      const code = isMark ? this.pickVariant(cp, cands, cluster) : cands[0];
      codes.push(code);
      width += this.widthOf(code);
      const g = this.glyph(code);
      if (!isMark) {
        const bb = g && g.bbox ? g.bbox : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
        const adv = g ? g.advanceWidth : 0;
        cluster = { base: code, top: bb.maxY, bottom: Math.min(0, bb.minY), baseMid: (bb.minX + bb.maxX) / 2 - adv };
      } else if (cluster && g && g.bbox) {
        if (THAI_ABOVE.has(cp)) cluster.top = Math.max(cluster.top, g.bbox.maxY);
        else cluster.bottom = Math.min(cluster.bottom, g.bbox.minY);
      }
    });
    const hex = codes.map((c) => c.toString(16).padStart(this.kind === 'cid' ? 4 : 2, '0')).join('');
    return { hex, width: (width / 1000) * size, missing, codes };
  }
}

export async function loadEmbeddedFonts(bytes) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFRef, decodePDFRawStream } = window.PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const L = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const nm = (o) => { const v = L(o); return v && v.decodeText ? v.decodeText() : v && v.asString ? v.asString() : ''; };
  const num = (o, d = 0) => { const v = L(o); return v && v.asNumber ? v.asNumber() : d; };
  const streamBytes = (o) => { const s = L(o); try { return decodePDFRawStream(s).decode(); } catch (_) { return null; } };
  const fonts = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const type = nm(obj.get(PDFName.of('Type')));
    if (type !== 'Font') continue;
    const sub = nm(obj.get(PDFName.of('Subtype')));
    const baseFont = nm(obj.get(PDFName.of('BaseFont')));
    try {
      let fdDict, widths = new Map(), defaultWidth = 1000, kind;
      const toUniStream = obj.get(PDFName.of('ToUnicode'));
      const toUni = toUniStream ? streamBytes(toUniStream) : null;
      const toUniMap = toUni ? parseToUnicode(new TextDecoder('latin1').decode(toUni)) : new Map();
      if (sub === 'Type0') {
        const enc = nm(obj.get(PDFName.of('Encoding')));
        if (enc !== 'Identity-H') continue;
        const desc = L(L(obj.get(PDFName.of('DescendantFonts'))).get(0));
        fdDict = L(desc.get(PDFName.of('FontDescriptor')));
        kind = 'cid';
        defaultWidth = num(desc.get(PDFName.of('DW')), 1000);
        const W = L(desc.get(PDFName.of('W')));
        if (W instanceof PDFArray) {
          const arr = W.asArray();
          for (let i = 0; i < arr.length;) {
            const first = num(arr[i]);
            const nxt = L(arr[i + 1]);
            if (nxt instanceof PDFArray) { nxt.asArray().forEach((w, k) => widths.set(first + k, num(w))); i += 2; }
            else { const last = num(arr[i + 1]), w = num(arr[i + 2]); for (let c = first; c <= last; c++) widths.set(c, w); i += 3; }
          }
        }
        const map = L(desc.get(PDFName.of('CIDToGIDMap')));
        if (map && !(map.decodeText && map.decodeText() === 'Identity')) continue; // only identity CID->GID
      } else if (sub === 'TrueType' || sub === 'Type1') {
        fdDict = L(obj.get(PDFName.of('FontDescriptor')));
        kind = 'simple';
        const first = num(obj.get(PDFName.of('FirstChar')));
        const W = L(obj.get(PDFName.of('Widths')));
        if (W instanceof PDFArray) W.asArray().forEach((w, k) => widths.set(first + k, num(w)));
        defaultWidth = num(fdDict && fdDict.get(PDFName.of('MissingWidth')), 0);
      } else continue;
      if (!fdDict) continue;
      const ff = fdDict.get(PDFName.of('FontFile2')) || fdDict.get(PDFName.of('FontFile3'));
      if (!ff) continue;
      const fbytes = streamBytes(ff);
      if (!fbytes) continue;
      const fk = window.fontkit.create(fbytes);
      const upem = fk.unitsPerEm;
      const uni2codes = new Map(), codeToUni = new Map();
      if (kind === 'cid') {
        toUniMap.forEach((cps, code) => {
          if (cps.length !== 1) return; // ligatures are not rebuilt
          codeToUni.set(code, cps);
          (uni2codes.get(cps[0]) || uni2codes.set(cps[0], []).get(cps[0])).push(code);
        });
      } else {
        // WinAnsi: code -> unicode, kept only where the embedded glyph has an outline
        for (let code = 32; code < 256; code++) {
          const cp = WIN1252[code] || code;
          codeToUni.set(code, [cp]);
          (uni2codes.get(cp) || uni2codes.set(cp, []).get(cp)).push(code);
        }
      }
      fonts.push(new EmbFont({ ref, dict: obj, ctx, rawName: baseFont, name: baseFont.replace(/^[A-Z]{6}\+/, ''), kind, fk, upem, widths, defaultWidth, uni2codes, codeToUni }));
    } catch (_) { /* a font we cannot read is simply skipped */ }
  }
  return {
    fonts,
    byRawName: (raw) => fonts.find((f) => f.rawName === raw) || null,
  };
}

// deep-copy a font dictionary (with its descriptor, font file, widths, ToUnicode)
// from the source PDF into another pdf-lib document; returns the new reference
export function copyFontInto(outDoc, emb) {
  const { PDFDict, PDFArray, PDFRef, PDFRawStream, PDFName } = window.PDFLib;
  const dst = outDoc.context, src = emb.ctx;
  const map = new Map();
  const cp = (o) => {
    if (o instanceof PDFRef) {
      const key = o.toString();
      if (map.has(key)) return map.get(key);
      const nref = dst.nextRef();
      map.set(key, nref);
      dst.assign(nref, cp(src.lookup(o)));
      return nref;
    }
    if (o instanceof PDFRawStream) return PDFRawStream.of(cp(o.dict), o.contents);
    if (o instanceof PDFDict) { const d = PDFDict.withContext(dst); o.entries().forEach(([k, v]) => d.set(k, cp(v))); return d; }
    if (o instanceof PDFArray) { const a = PDFArray.withContext(dst); o.asArray().forEach((v) => a.push(cp(v))); return a; }
    return o;
  };
  return cp(emb.ref);
}
