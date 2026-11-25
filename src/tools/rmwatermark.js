// Remove Watermark — finds watermarks that were ADDED on top of a PDF page and cuts
// exactly those drawing instructions out of the page, leaving every other byte of the
// page untouched (text stays text, scans stay scans, nothing is re-drawn as an image).
//
// A watermark is not a special object in most PDFs; it is just more drawing on the
// page. So we read each page's content stream, split it into self-contained drawing
// blocks (q..Q / BDC..EMC), and flag a block as a watermark when:
//   * the file itself labels it a watermark (marked-content tag, optional layer, or a
//     /Watermark annotation);
//   * it is text or shapes laid out on a diagonal;
//   * it is semi-transparent;
//   * or it repeats identically on most pages in the middle of the page (a header or
//     footer that repeats is listed too, but left unticked).
// The user reviews every item and can tick or untick it before anything is removed.
//
// No look-behind regex (old Safari). Everything runs in the browser.

const FNV = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const ID = [1, 0, 0, 1, 0, 0];

// ------------------------------------------------------------ content parser
// Turns a content stream (as a latin1 string) into [{op, args, s, e}] where s..e is the
// whole statement (operands included) so it can be cut out byte-exactly.
export function parseContent(s) {
  const ops = []; let args = []; let stmt = -1; let i = 0; const n = s.length;
  const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  const skipWs = () => {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (isWs(c)) i++;
      else if (c === 37) { while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++; }
      else break;
    }
  };
  const readString = () => {
    let depth = 1; let out = ''; i++;
    while (i < n) {
      const ch = s[i];
      if (ch === '\\') { out += ch + (s[i + 1] || ''); i += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (!depth) { i++; break; } }
      out += ch; i++;
    }
    return { str: out };
  };
  const readValue = () => {
    skipWs();
    const c = s.charCodeAt(i);
    if (c === 40) return readString();
    if (c === 47) { let j = i + 1; while (j < n && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++; const name = s.slice(i + 1, j); i = j; return { name }; }
    if (c === 91) { i++; const arr = []; for (;;) { skipWs(); if (i >= n) break; if (s.charCodeAt(i) === 93) { i++; break; } arr.push(readValue()); } return { arr }; }
    if (c === 60) {
      if (s.charCodeAt(i + 1) === 60) {
        i += 2; const start = i; let depth = 1;
        while (i < n && depth) {
          if (s.charCodeAt(i) === 60 && s.charCodeAt(i + 1) === 60) { depth++; i += 2; }
          else if (s.charCodeAt(i) === 62 && s.charCodeAt(i + 1) === 62) { depth--; i += 2; }
          else if (s.charCodeAt(i) === 40) readString();
          else i++;
        }
        return { dict: s.slice(start, Math.max(start, i - 2)) };
      }
      const j = s.indexOf('>', i); const hex = s.slice(i + 1, j < 0 ? n : j); i = (j < 0 ? n : j + 1); return { hex };
    }
    let j = i;
    while (j < n && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
    if (j === i) { i++; return { op: s[i - 1] }; }
    const w = s.slice(i, j); i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return +w;
    return { op: w };
  };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    if (stmt < 0) stmt = i;
    const v = readValue();
    if (v && typeof v === 'object' && v.op !== undefined) {
      if (v.op === 'BI') {
        const idm = /[\s\0]ID[\s\0]/.exec(s.slice(i, i + 4000));
        let end = n;
        if (idm) {
          const from = i + idm.index + idm[0].length;
          const em = /[\s\0]EI(?=[\s\0]|$)/.exec(s.slice(from));
          end = em ? from + em.index + em[0].length : n;
        }
        i = end;
        ops.push({ op: 'BI', args: [], s: stmt, e: i });
      } else {
        ops.push({ op: v.op, args, s: stmt, e: i });
      }
      args = []; stmt = -1;
    } else args.push(v);
  }
  return ops;
}

// ------------------------------------------------------------ block analysis
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'sh']);
const PATHOP = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
const num = (a, i) => (typeof a[i] === 'number' ? a[i] : 0);

// res: { gsAlpha(name), xobj(name), props(name) } supplied by the caller.
export function analyzeBlocks(ops, text, res, base, depthLimit = 0) {
  const blocks = [];
  let ctm = ID; const stack = []; let depth = 0;
  let cur = null;
  let tm = ID, tlm = ID, fs = 10, lead = 0, tr = 0;
  let pathPts = []; let pathStart = -1;
  const fresh = (s) => ({ s, e: s, pts: [], hasText: false, hasImage: false, hasForm: false, hasPath: false, angle: null, alpha: 1, tagged: false, invisible: false, name: '', refs: [], chars: 0 });
  const open = (s) => { cur = fresh(s); };
  const close = (e) => { if (cur) { cur.e = e; cur.raw = text.slice(cur.s, cur.e); blocks.push(cur); cur = null; } };
  const quad = (m, w, h, d) => [[0, -d], [w, -d], [w, h - d], [0, h - d]].map(([x, y]) => apply(m, x, y));

  const showText = (str, bytes) => {
    if (!cur) return;
    const w = Math.max(0.1, bytes * 0.5) * fs; // rough advance in text space (only used for highlighting)
    const trm = mul(tm, ctm);
    const ang = Math.atan2(trm[1], trm[0]) * 180 / Math.PI;
    if (cur.angle === null) cur.angle = ang;
    cur.hasText = true; cur.chars += bytes;
    if (tr === 3) cur.invisible = true;
    quad(trm, w, fs, fs * 0.2).forEach((p) => cur.pts.push(p));
    tm = mul([1, 0, 0, 1, w, 0], tm);
  };
  const strBytes = (v) => (v && v.str !== undefined ? Math.max(1, v.str.replace(/\\(\d{1,3}|.)/g, 'x').length) : v && v.hex !== undefined ? Math.max(1, Math.ceil(v.hex.replace(/\s/g, '').length / 2)) : 0);

  const tagCheck = (op) => {
    if (!cur) return;
    const a = op.args;
    const tag = a[0] && a[0].name;
    const p = a[1];
    let txt = '';
    if (p && p.dict !== undefined) txt = p.dict;
    else if (p && p.name !== undefined) { const pr = res.props(p.name); if (pr) txt = pr; }
    if (/Subtype\s*\/Watermark/.test(txt) || (tag === 'Watermark')) cur.tagged = true;
    if (tag === 'OC' && /watermark/i.test(txt)) cur.tagged = true;
    if (/\/Name\s*\(?[^)\/]*watermark/i.test(txt)) cur.tagged = true;
  };

  for (const op of ops) {
    const o = op.op; const a = op.args;
    const before = depth;
    if (o === 'q') { stack.push(ctm); depth++; if (!cur && before === base) open(op.s); }
    else if (o === 'Q') { if (stack.length) ctm = stack.pop(); depth--; }
    else if (o === 'BDC' || o === 'BMC') { depth++; if (!cur && before === base) open(op.s); tagCheck(op); }
    else if (o === 'EMC') { depth--; }
    else {
      // an implicit block: drawing that is not wrapped in q..Q or marked content
      if (!cur && depth === base) {
        if (o === 'BT') open(op.s);
        else if (o === 'Do' || o === 'BI') open(op.s);
        else if (PATHOP.has(o) && pathStart < 0) pathStart = op.s;
      }
      switch (o) {
        case 'cm': ctm = mul([num(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 4), num(a, 5)], ctm); break;
        case 'gs': { const al = res.gsAlpha(a[0] && a[0].name); if (cur && al < cur.alpha) cur.alpha = al; break; }
        case 'BT': tm = tlm = ID; break;
        case 'Tf': fs = Math.abs(num(a, 1)) || fs; break;
        case 'TL': lead = num(a, 0); break;
        case 'Tr': tr = num(a, 0); break;
        case 'Tm': tm = tlm = [num(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 4), num(a, 5)]; break;
        case 'Td': tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], tlm); tm = tlm; break;
        case 'TD': lead = -num(a, 1); tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], tlm); tm = tlm; break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = tlm; break;
        case 'Tj': showText(a[0], strBytes(a[0])); break;
        case '\'': tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = tlm; showText(a[0], strBytes(a[0])); break;
        case '"': tlm = mul([1, 0, 0, 1, 0, -lead], tlm); tm = tlm; showText(a[2], strBytes(a[2])); break;
        case 'TJ': { const arr = (a[0] && a[0].arr) || []; let b = 0; arr.forEach((v) => { b += strBytes(v); }); if (b) showText(null, b); break; }
        case 're': { const x = num(a, 0), y = num(a, 1), w = num(a, 2), h = num(a, 3); [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].forEach(([px, py]) => pathPts.push(apply(ctm, px, py))); break; }
        case 'm': case 'l': pathPts.push(apply(ctm, num(a, 0), num(a, 1))); break;
        case 'c': pathPts.push(apply(ctm, num(a, 0), num(a, 1)), apply(ctm, num(a, 2), num(a, 3)), apply(ctm, num(a, 4), num(a, 5))); break;
        case 'v': case 'y': pathPts.push(apply(ctm, num(a, 0), num(a, 1)), apply(ctm, num(a, 2), num(a, 3))); break;
        case 'n': pathPts = []; pathStart = -1; break; // clip-only path: not visible
        case 'Do': {
          const xo = res.xobj(a[0] && a[0].name, depthLimit);
          if (cur && xo) {
            cur.refs.push(xo.ref);
            if (xo.kind === 'image') { cur.hasImage = true; [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([x, y]) => cur.pts.push(apply(ctm, x, y))); }
            else {
              cur.hasForm = true;
              const m = mul(xo.matrix || ID, ctm); const bb = xo.bbox;
              if (bb) [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].forEach(([x, y]) => cur.pts.push(apply(m, x, y)));
              if (xo.inner) {
                if (xo.inner.alpha < cur.alpha) cur.alpha = xo.inner.alpha;
                if (xo.inner.tagged) cur.tagged = true;
                if (xo.inner.angle !== null && cur.angle === null) cur.angle = xo.inner.angle;
                if (xo.inner.hasText) cur.hasText = true;
              }
            }
          }
          break;
        }
        case 'BI': if (cur) { cur.hasImage = true; [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([x, y]) => cur.pts.push(apply(ctm, x, y))); } break;
        default: break;
      }
      if (PAINT.has(o)) {
        if (cur) { if (pathPts.length) { cur.hasPath = true; pathPts.forEach((p) => cur.pts.push(p)); } }
        else if (pathStart >= 0 && depth === base) { const b = fresh(pathStart); b.hasPath = true; b.pts = pathPts.slice(); b.e = op.e; b.raw = text.slice(b.s, b.e); blocks.push(b); }
        pathPts = []; pathStart = -1;
      }
      if (cur && !cur.explicitOpen && depth === base && (o === 'ET' || o === 'Do' || o === 'BI') && before === base && cur.s >= 0) { close(op.e); }
    }
    if (cur && depth === base && before > base) close(op.e);
  }
  if (cur) close(ops.length ? ops[ops.length - 1].e : 0);
  const out = [];
  for (const b of blocks) {
    if (!b.pts.length) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    b.pts.forEach(([x, y]) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; });
    b.bbox = [x0, y0, x1, y1];
    if (b.hasPath && !b.hasText && !b.hasImage && !b.hasForm && b.pts.length >= 12) b.pathAngle = principalAngle(b.pts);
    out.push(b);
  }
  return out;
}

// direction of the longest axis of a point cloud: {angle (deg), elong}
function principalAngle(pts) {
  let mx = 0, my = 0; pts.forEach(([x, y]) => { mx += x; my += y; }); mx /= pts.length; my /= pts.length;
  let cxx = 0, cyy = 0, cxy = 0; pts.forEach(([x, y]) => { cxx += (x - mx) ** 2; cyy += (y - my) ** 2; cxy += (x - mx) * (y - my); });
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy; const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-9, tr / 2 - disc);
  return { angle: 0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180 / Math.PI, elong: Math.sqrt(l1 / l2) };
}
const isDiagonal = (deg) => { const d = ((Math.abs(deg) % 90) + 90) % 90; return d > 8 && d < 82; };

// ------------------------------------------------------------ the tool
export function initRmWatermark() {
  const { $, $$, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, renderPreview, PDFLib } = window.appHelpers;
  if (!$('#dz-rmwatermark')) return;
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFString, PDFHexString, PDFStream, decodePDFRawStream } = PDFLib;

  const st = { file: null, doc: null, pageNum: 1, items: [], vps: {}, busy: false };
  const wrap = () => $('#wrap-rmwatermark');
  const COLORS = ['#e11d48', '#d97706', '#7c3aed', '#0284c7', '#059669', '#db2777'];
  const sel = () => st.items.filter((it) => it.on);
  const pageList = (set) => {
    const a = [...set].sort((x, y) => x - y); const parts = []; let i = 0;
    while (i < a.length) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; parts.push(j > i + 1 ? `${a[i]}–${a[j]}` : a.slice(i, j + 1).join(', ')); i = j + 1; }
    return parts.join(', ');
  };
  const updateReady = () => {
    const n = sel().length;
    $('#btn-rmwatermark').disabled = !(st.file && n);
    $('#btn-rmwatermark').textContent = n ? `Remove ${n} Watermark${n > 1 ? 's' : ''}` : 'Remove Watermark';
  };

  // ---- resource helpers (pdf-lib objects) ----
  const dec = (obj) => { try { return decodePDFRawStream(obj).decode(); } catch (_) { return obj.getContents ? obj.getContents() : new Uint8Array(); } };
  const toStr = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
  const textOf = (o) => { try { return o && o.decodeText ? o.decodeText() : o && o.asString ? o.asString() : ''; } catch (_) { return ''; } };

  const makeRes = (ctx, resDict, depthLimit) => {
    const getDict = (key) => { try { return resDict ? resDict.lookupMaybe(PDFName.of(key), PDFDict) : undefined; } catch (_) { return undefined; } };
    const gsd = getDict('ExtGState'), xod = getDict('XObject'), prd = getDict('Properties');
    return {
      gsAlpha(name) {
        if (!gsd || !name) return 1;
        try {
          const d = gsd.lookupMaybe(PDFName.of(name), PDFDict); if (!d) return 1;
          let a = 1;
          ['ca', 'CA'].forEach((k) => { const v = d.lookupMaybe(PDFName.of(k), PDFNumber); if (v && v.asNumber() < a) a = v.asNumber(); });
          return a;
        } catch (_) { return 1; }
      },
      props(name) {
        if (!prd || !name) return '';
        try {
          const d = prd.lookupMaybe(PDFName.of(name), PDFDict); if (!d) return '';
          let t = '';
          const sub = d.get(PDFName.of('Subtype')); if (sub) t += `/Subtype ${sub.toString()} `;
          const nm = d.lookup(PDFName.of('Name')); if (nm) t += `/Name (${textOf(nm)}) `;
          return t;
        } catch (_) { return ''; }
      },
      xobj(name, dl) {
        if (!xod || !name) return null;
        try {
          const raw = xod.get(PDFName.of(name)); if (!raw) return null;
          const obj = ctx.lookup(raw); if (!obj || !obj.dict) return null;
          const sub = obj.dict.get(PDFName.of('Subtype'));
          const ref = raw.tag || raw.toString();
          if (sub && sub.toString() === '/Image') return { kind: 'image', ref };
          const bb = obj.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
          const mt = obj.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
          const nums = (arr) => arr ? arr.asArray().map((v) => (v && v.asNumber ? v.asNumber() : 0)) : null;
          const out = { kind: 'form', ref, bbox: nums(bb), matrix: nums(mt) };
          // one level of look-inside, for the watermark clues a form can carry
          if (dl < 2) {
            const sres = obj.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
            const ops = parseContent(toStr(dec(obj)));
            const t = toStr(dec(obj));
            const bl = analyzeBlocks(ops, t, makeRes(ctx, sres || resDict, dl + 1), 0, dl + 1);
            const flat = { alpha: 1, tagged: false, angle: null, hasText: false };
            bl.forEach((b) => { if (b.alpha < flat.alpha) flat.alpha = b.alpha; if (b.tagged) flat.tagged = true; if (b.angle !== null && flat.angle === null) flat.angle = b.angle; if (b.hasText) flat.hasText = true; });
            out.inner = flat;
          }
          const oc = obj.dict.lookup(PDFName.of('OC'));
          if (oc && oc.dict === undefined && oc.lookup) { const nm = oc.lookup(PDFName.of('Name')); if (nm && /watermark/i.test(textOf(nm))) { out.inner = out.inner || { alpha: 1, angle: null, hasText: false }; out.inner.tagged = true; } }
          return out;
        } catch (_) { return null; }
      },
    };
  };

  const pageContent = (pdf, page) => {
    const ctx = pdf.context;
    const c = page.node.Contents();
    let parts = [];
    if (c instanceof PDFArray) parts = c.asArray().map((r) => ctx.lookup(r)).filter(Boolean);
    else if (c) parts = [c];
    const chunks = parts.map((p) => toStr(dec(p)));
    return chunks.join('\n');
  };

  // ---- analysis ----
  async function analyse(bytes) {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    const pages = pdf.getPages();
    const ctx = pdf.context;
    const per = [];
    let base = 0;
    for (let p = 0; p < pages.length; p++) {
      const page = pages[p];
      const text = pageContent(pdf, page);
      const ops = parseContent(text);
      const res = makeRes(ctx, page.node.Resources(), 0);
      if (p === 0 || (per[0] && per[0].blocks.length === 0 && p < 3)) {
        let best = -1;
        for (const b of [0, 1, 2]) { const n = analyzeBlocks(ops, text, res, b).length; if (n > best + 0 && (n >= 4 || best < 0)) { best = n; base = b; if (n >= 4) break; } }
      }
      const blocks = analyzeBlocks(ops, text, res, base);
      const annots = [];
      try {
        const an = page.node.Annots();
        if (an) an.asArray().forEach((r, idx) => {
          const d = ctx.lookupMaybe(r, PDFDict); if (!d) return;
          const sub = d.get(PDFName.of('Subtype')); const rect = d.lookupMaybe(PDFName.of('Rect'), PDFArray);
          const nm = sub ? sub.toString().slice(1) : '';
          if ((nm === 'Watermark' || nm === 'Stamp') && rect) { const v = rect.asArray().map((q) => (q.asNumber ? q.asNumber() : 0)); annots.push({ idx, kind: nm, bbox: [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])] }); }
        });
      } catch (_) { /* no annotations */ }
      const mb = page.getMediaBox();
      per.push({ blocks, text, annots, w: mb.width, h: mb.height, ox: mb.x, oy: mb.y });
      if (p % 5 === 4) await new Promise((r) => setTimeout(r));
    }
    return { pdf, per, base };
  }

  function classify(per) {
    const N = per.length;
    const need = N >= 2 ? Math.max(2, Math.ceil(N * 0.6)) : Infinity;
    const norm = (b) => FNV(b.raw.replace(/\/MCID\s+\d+/g, '').replace(/\s+/g, ' '));
    const seen = new Map();
    per.forEach((pg, pi) => pg.blocks.forEach((b) => { b.sig = norm(b); if (!seen.has(b.sig)) seen.set(b.sig, new Set()); seen.get(b.sig).add(pi); }));
    const items = new Map();
    per.forEach((pg, pi) => {
      const area = pg.w * pg.h;
      let run = null;
      const flush = () => {
        if (!run) return;
        // one row per kind (a watermark's pieces differ a little page to page); repeats stay separate per distinct stamp
        const key = run.kind === 'repeat' ? `repeat|${FNV(run.sigs.join(','))}` : run.kind;
        let it = items.get(key);
        if (!it) { it = { key, kind: run.kind, on: run.on, pages: new Set(), boxes: {}, ranges: {}, text: false, image: false, shapes: false, reps: 0 }; items.set(key, it); }
        it.pages.add(pi + 1);
        (it.boxes[pi + 1] = it.boxes[pi + 1] || []).push(...run.boxes);
        (it.ranges[pi + 1] = it.ranges[pi + 1] || []).push(...run.ranges);
        it.text = it.text || run.text; it.image = it.image || run.image; it.shapes = it.shapes || run.shapes;
        it.reps = Math.max(it.reps, run.reps);
        run = null;
      };
      pg.blocks.forEach((b) => {
        const [x0, y0, x1, y1] = b.bbox;
        const bw = Math.max(0, Math.min(x1, pg.ox + pg.w) - Math.max(x0, pg.ox)), bh = Math.max(0, Math.min(y1, pg.oy + pg.h) - Math.max(y0, pg.oy));
        const cover = (bw * bh) / area;
        const cx = ((x0 + x1) / 2 - pg.ox) / pg.w, cy = ((y0 + y1) / 2 - pg.oy) / pg.h;
        const edge = cy < 0.1 || cy > 0.9 || cx < 0.04 || cx > 0.96 || (y1 - pg.oy) / pg.h < 0.14 || (y0 - pg.oy) / pg.h > 0.86;
        const reps = seen.get(b.sig).size;
        let kind = null, on = true;
        if (b.invisible) kind = null;
        else if (b.tagged) kind = 'tag';
        else if (cover > 0.85 && !(b.alpha < 0.95 && (b.hasImage || b.hasForm))) kind = null;
        else if (b.angle !== null && b.hasText && isDiagonal(b.angle)) kind = 'diag';
        else if (b.pathAngle && b.pathAngle.elong >= 2.2 && isDiagonal(b.pathAngle.angle) && Math.hypot(x1 - x0, y1 - y0) > 25) kind = 'diag';
        else if (b.alpha < 0.9) kind = 'trans';
        else if (reps >= need && cover < 0.7) { kind = 'repeat'; on = !edge; }
        if (!kind) { flush(); return; }
        const cls = kind === 'repeat' ? (on ? 'repeat' : 'edge') : kind;
        if (run && run.cls !== cls) flush();
        if (!run) run = { kind: cls, cls, on, sigs: [], boxes: [], ranges: [], text: false, image: false, shapes: false, reps: 0 };
        run.sigs.push(b.sig); run.boxes.push(b.bbox); run.ranges.push([b.s, b.e]);
        run.text = run.text || b.hasText; run.image = run.image || b.hasImage || b.hasForm; run.shapes = run.shapes || (b.hasPath && !b.hasText);
        run.reps = Math.max(run.reps, reps);
      });
      flush();
      pg.annots.forEach((an) => {
        const key = `annot|${an.kind}`;
        let it = items.get(key);
        if (!it) { it = { key, kind: 'annot' + an.kind, on: an.kind === 'Watermark', pages: new Set(), boxes: {}, ranges: {}, annIdx: {}, text: false, image: false, shapes: false, reps: 0 }; items.set(key, it); }
        it.pages.add(pi + 1);
        (it.boxes[pi + 1] = it.boxes[pi + 1] || []).push(an.bbox);
        (it.annIdx[pi + 1] = it.annIdx[pi + 1] || []).push(an.idx);
      });
    });
    const label = (it) => {
      const what = it.text && it.shapes ? 'text' : it.text ? 'text' : it.image ? 'image' : it.shapes ? 'shapes / outlined text' : 'item';
      const n = it.pages.size;
      switch (it.kind) {
        case 'tag': return `Marked as a watermark inside the file (${what})`;
        case 'diag': return `Diagonal watermark (${what})`;
        case 'trans': return `Semi-transparent overlay (${what})`;
        case 'repeat': return `Same ${what} on ${n} page${n > 1 ? 's' : ''} over the content`;
        case 'edge': return `Header / footer-style ${what} repeated on ${n} page${n > 1 ? 's' : ''} (kept by default)`;
        case 'annotWatermark': return 'Watermark annotation';
        case 'annotStamp': return 'Stamp annotation (kept by default)';
        default: return what;
      }
    };
    const arr = [...items.values()];
    arr.forEach((it, i) => { it.label = label(it); it.color = COLORS[i % COLORS.length]; it.id = i; });
    const order = { tag: 0, diag: 1, annotWatermark: 2, trans: 3, repeat: 4, annotStamp: 5, edge: 6 };
    arr.sort((a, b) => (order[a.kind] - order[b.kind]) || (b.pages.size - a.pages.size));
    arr.forEach((it, i) => { it.color = COLORS[i % COLORS.length]; });
    return arr;
  }

  // ---- UI ----
  const vpFor = async (n) => {
    if (!st.vps[n]) { const pg = await st.doc.getPage(n); st.vps[n] = pg.getViewport({ scale: 1 }); }
    return st.vps[n];
  };
  const renderList = () => {
    const el = $('#rw-list'); el.textContent = '';
    st.items.forEach((it) => {
      const row = document.createElement('label');
      row.className = 'flex items-start gap-3 py-2 px-3 rounded-xl border border-slate-200 bg-white cursor-pointer text-sm';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = it.on; cb.className = 'mt-1';
      cb.addEventListener('change', () => { it.on = cb.checked; drawBoxes(); updateReady(); renderSummary(); });
      const sw = document.createElement('span'); sw.style.cssText = `display:inline-block;width:12px;height:12px;border-radius:3px;margin-top:4px;background:${it.color};flex:none`;
      const tx = document.createElement('span');
      tx.innerHTML = '<span class="font-semibold"></span><span class="block text-xs text-slate-500"></span>';
      tx.firstChild.textContent = it.label;
      tx.lastChild.textContent = `Pages ${pageList(it.pages)}`;
      row.append(cb, sw, tx);
      el.appendChild(row);
    });
  };
  const renderSummary = () => {
    const el = $('#rw-summary');
    if (!st.items.length) { el.textContent = ''; return; }
    el.textContent = `Found ${st.items.length} candidate${st.items.length > 1 ? 's' : ''}; ${sel().length} will be removed. Tick or untick each one, and check the page below.`;
  };
  async function drawBoxes() {
    $$('.rw-box', wrap()).forEach((m) => m.remove());
    const n = st.pageNum;
    const vp = await vpFor(n);
    st.items.forEach((it) => {
      (it.boxes[n] || []).forEach((bb) => {
        const r = vp.convertToViewportRectangle([bb[0], bb[1], bb[2], bb[3]]);
        const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]), w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
        const d = document.createElement('div');
        d.className = 'rw-box';
        d.title = `${it.label} — click to ${it.on ? 'keep' : 'remove'}`;
        d.style.cssText = `position:absolute;left:${(x / vp.width) * 100}%;top:${(y / vp.height) * 100}%;width:${Math.max(0.6, (w / vp.width) * 100)}%;height:${Math.max(0.4, (h / vp.height) * 100)}%;cursor:pointer;box-sizing:border-box;` +
          (it.on ? `background:${it.color}1f;border:1.5px solid ${it.color};` : 'background:transparent;border:1.5px dashed #10b981;');
        d.addEventListener('click', (e) => { e.stopPropagation(); it.on = !it.on; renderList(); drawBoxes(); renderSummary(); updateReady(); });
        wrap().appendChild(d);
      });
    });
  }

  setupDropzone('rmwatermark', async ([f]) => {
    if (st.busy) return;
    st.busy = true;
    try {
      st.file = f; st.items = []; st.vps = {}; hideResult('rmwatermark');
      $('#work-rmwatermark').classList.add('hidden');
      setStatus('rmwatermark', 'Looking for watermarks…');
      const data = await f.arrayBuffer();
      st.bytes = new Uint8Array(data.slice(0));
      st.doc = await loadPdfJs(data.slice(0));
      st.pageNum = 1;
      $('#page-rmwatermark').value = 1; $('#page-rmwatermark').max = st.doc.numPages;
      $('#pages-rmwatermark').textContent = `/ ${st.doc.numPages}`;
      $('#picked-rmwatermark').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      const a = await analyse(st.bytes.slice());
      st.items = classify(a.per);
      $('#work-rmwatermark').classList.remove('hidden');
      await renderPreview(st, '#preview-rmwatermark', '#wrap-rmwatermark');
      renderList(); renderSummary(); await drawBoxes();
      const first = st.items.find((it) => it.on) || st.items[0];
      if (first) { const p = Math.min(...first.pages); if (p !== 1) { st.pageNum = p; $('#page-rmwatermark').value = p; await renderPreview(st, '#preview-rmwatermark', '#wrap-rmwatermark'); await drawBoxes(); } }
      setStatus('rmwatermark', st.items.length ? '' : 'No watermark found that can be taken out cleanly. If it is part of a scanned picture, use Smart Erase instead.', st.items.length ? undefined : 'error');
    } catch (err) {
      const enc = /encrypt/i.test(String(err && err.message));
      setStatus('rmwatermark', `❌ ${enc ? 'This PDF is password-protected — unlock it first.' : (err.message || err)}`, 'error');
    } finally { st.busy = false; updateReady(); }
  });
  $('#page-rmwatermark').addEventListener('change', async () => {
    if (!st.doc) return;
    st.pageNum = Math.min(Math.max(1, +$('#page-rmwatermark').value || 1), st.doc.numPages);
    $('#page-rmwatermark').value = st.pageNum;
    await renderPreview(st, '#preview-rmwatermark', '#wrap-rmwatermark');
    await drawBoxes();
  });

  $('#btn-rmwatermark').addEventListener('click', async () => {
    const f = st.file; if (!f) return;
    const btn = $('#btn-rmwatermark'); btn.disabled = true; hideResult('rmwatermark');
    try {
      setStatus('rmwatermark', 'Removing…');
      const pdf = await PDFDocument.load(st.bytes.slice(), { updateMetadata: false });
      const pages = pdf.getPages(); const ctx = pdf.context;
      const chosen = sel(); let cutBlocks = 0; const touched = new Set();
      for (let p = 0; p < pages.length; p++) {
        const ranges = [];
        chosen.forEach((it) => (it.ranges[p + 1] || []).forEach((r) => ranges.push(r)));
        if (ranges.length) {
          const page = pages[p];
          const text = pageContent(pdf, page);
          ranges.sort((a, b) => b[0] - a[0]);
          let out = text; let lastS = Infinity;
          ranges.forEach(([s, e]) => { if (e <= lastS) { out = out.slice(0, s) + '\n' + out.slice(e); lastS = s; cutBlocks++; } });
          const bytes = new Uint8Array(out.length);
          for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
          const ref = ctx.register(ctx.flateStream(bytes));
          page.node.set(PDFName.of('Contents'), ref);
          touched.add(p + 1);
        }
        const idxs = [];
        chosen.forEach((it) => ((it.annIdx && it.annIdx[p + 1]) || []).forEach((i) => idxs.push(i)));
        if (idxs.length) {
          const an = pages[p].node.Annots();
          if (an) { idxs.sort((a, b) => b - a).forEach((i) => an.remove(i)); touched.add(p + 1); cutBlocks += idxs.length; }
        }
      }
      const bytes = await pdf.save({ useObjectStreams: true });
      showResult('rmwatermark', bytes, `${baseName(f.name)}_no_watermark.pdf`, 'application/pdf', `Removed ${chosen.length} watermark${chosen.length > 1 ? 's' : ''} from ${touched.size} page${touched.size > 1 ? 's' : ''} · ${fmtBytes(bytes.length)}`);
      // show the first changed page so the result can be checked at a glance
      try {
        const out = await loadPdfJs(bytes.slice().buffer);
        const first = Math.min(...touched);
        const pg = await out.getPage(first); const vp = pg.getViewport({ scale: Math.min(1, 520 / pg.getViewport({ scale: 1 }).width) * 1.5 });
        const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height; cv.className = 'border border-slate-300 rounded-xl max-w-full';
        cv.style.width = `${vp.width / 1.5}px`;
        await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        const holder = $('#preview-result-rmwatermark'); holder.textContent = '';
        const cap = document.createElement('div'); cap.className = 'text-xs text-slate-500 mb-1.5'; cap.textContent = `Result, page ${first}`;
        holder.append(cap, cv); holder.classList.remove('hidden');
      } catch (_) { /* preview is optional */ }
      setStatus('rmwatermark', '');
    } catch (err) {
      setStatus('rmwatermark', `❌ ${err.message || err}`, 'error');
    } finally { updateReady(); }
  });
}
