// Layout-aware PDF -> Office export. Reads each page's real text with pdf.js and
// rebuilds structure instead of dumping a flat list of words:
//   * runs keep their font family, size, bold/italic and colour
//   * words are joined into lines and wrapped lines into paragraphs
//   * aligned columns become real tables
//   * pictures are cropped from the page and placed in reading order
//   * Thai text is never split with stray spaces (a common failure of simple
//     extractors, because pdf.js hands back one item per glyph cluster)
// Output: a genuine .docx (Office Open XML) built with JSZip, plus row/cell data
// for Excel and per-page text for PowerPoint notes.
import { extractLines, damagedCount } from './textlayer.js';
import { parseFontName } from './fontmatch.js';

const THAI = /[฀-๿]/;
const esc = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const NUM = /^\(?[-−]?[฿$€£]?\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?\)?$|^[-−]?[฿$€£]?\d+(?:\.\d+)?%?$/;

// joins two text pieces with a space only when there is a real gap and no Thai
// letter touches the join (Thai is written without spaces between words)
const glue = (a, b, gap, size, hint) => {
  if (!a) return b;
  if (hint && !/\s$/.test(a) && !/^\s/.test(b)) return `${a} ${b}`;
  if (!b) return a;
  if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
  const thaiJoin = THAI.test(a.slice(-1)) && THAI.test(b[0]);
  if (gap > size * 0.14 && !(thaiJoin && gap < size * 0.15)) return `${a} ${b}`;
  return a + b;
};

// ---------------------------------------------------------------- analysis
function textColor(ctx, scale, x, y, w, h) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const px = Math.max(0, Math.floor(x * scale)), py = Math.max(0, Math.floor(y * scale));
  const pw = Math.max(1, Math.min(cw - px, Math.ceil(w * scale))), ph = Math.max(1, Math.min(ch - py, Math.ceil(h * scale)));
  const d = ctx.getImageData(px, py, pw, ph).data;
  const med = [0, 1, 2].map((k) => { const a = []; for (let i = k; i < d.length; i += 4) a.push(d[i]); a.sort((p, q) => p - q); return a[a.length >> 1]; });
  let best = -1, bi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.abs(d[i] - med[0]) + Math.abs(d[i + 1] - med[1]) + Math.abs(d[i + 2] - med[2]);
    if (dist > best) { best = dist; bi = i; }
  }
  if (best < 60) return null;
  const hex = [d[bi], d[bi + 1], d[bi + 2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  return d[bi] + d[bi + 1] + d[bi + 2] < 150 ? null : hex; // near-black text needs no colour
}

// pictures on a page: unit-square images transformed by the current matrix
async function pageImages(page, vp, canvas, scale) {
  const OPS = window.pdfjsLib.OPS, U = window.pdfjsLib.Util;
  let list;
  try { list = await page.getOperatorList(); } catch (_) { return []; }
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const out = [];
  const imgOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((v) => v != null));
  list.fnArray.forEach((fn, i) => {
    const a = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = U.transform(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (a && a[0]) ctm = U.transform(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (imgOps.has(fn)) {
      const m = U.transform(vp.transform, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      out.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    }
  });
  const W = vp.width, H = vp.height;
  return out.filter((r) => r.w >= 14 && r.h >= 14 && !(r.w > W * 0.9 && r.h > H * 0.9)).map((r) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r.w * scale)); c.height = Math.max(1, Math.round(r.h * scale));
    c.getContext('2d').drawImage(canvas, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, c.width, c.height);
    return { ...r, canvas: c };
  });
}

export async function analyzePage(page, { images = true } = {}) {
  const SCALE = 2;
  const vp = page.getViewport({ scale: 1 });
  const canvas = document.createElement('canvas');
  const rv = page.getViewport({ scale: SCALE });
  canvas.width = Math.ceil(rv.width); canvas.height = Math.ceil(rv.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: rv }).promise; // also loads the page's fonts
  const { width, height, lines } = await extractLines(page, { split: true });

  const segs = lines.map((l) => {
    let raw = '';
    try { raw = page.commonObjs.get(l.fontName).name || ''; } catch (_) {}
    const f = parseFontName(raw);
    return {
      str: l.str.replace(/\s+$/, ''), sp: /\s$/.test(l.str), x: l.x, right: l.x + l.w, base: l.base, size: l.size,
      family: f.family, bold: f.weight >= 600, italic: f.italic,
      color: textColor(ctx, SCALE, l.x, l.base - l.size * 0.95, l.w, l.size * 1.2),
    };
  }).filter((s) => s.str);

  // ---- visual lines: segments sharing a baseline, left to right
  segs.sort((a, b) => a.base - b.base || a.x - b.x);
  const vlines = [];
  segs.forEach((s) => {
    const v = vlines[vlines.length - 1];
    if (v && Math.abs(v.base - s.base) <= 0.4 * Math.min(v.size, s.size)) {
      v.segs.push(s);
      v.base = (v.base * (v.segs.length - 1) + s.base) / v.segs.length;
      v.size = Math.max(v.size, s.size);
    } else vlines.push({ base: s.base, size: s.size, segs: [s] });
  });
  // column anchors: x positions where later segments of several lines start together.
  // pdf.js can over-report a label's width (stacked Thai tone marks carry an advance),
  // so a shared start position is a more trustworthy column signal than the gap.
  const starts = [];
  vlines.forEach((v) => { v.segs.sort((a, b) => a.x - b.x); v.segs.slice(1).forEach((sg) => starts.push({ x: sg.x, v })); });
  starts.sort((a, b) => a.x - b.x);
  const anchors = [];
  for (let k = 0; k < starts.length;) {
    let e = k;
    while (e + 1 < starts.length && starts[e + 1].x - starts[k].x < 3) e++;
    if (new Set(starts.slice(k, e + 1).map((q) => q.v)).size >= 2) anchors.push(starts[k].x);
    k = e + 1;
  }
  vlines.forEach((v) => {
    // split into cells where the horizontal gap is wide (a column gutter)
    v.cells = [];
    v.segs.forEach((s) => {
      const c = v.cells[v.cells.length - 1];
      const gap = c ? s.x - c.right : 0;
      if (c && gap < Math.max(0.7 * v.size, 6) && !anchors.some((ax) => Math.abs(ax - s.x) < 3)) { c.runs.push({ ...s, gap }); c.right = s.right; }
      else v.cells.push({ x: s.x, right: s.right, runs: [{ ...s, gap: 0 }] });
    });
    v.left = v.segs[0].x; v.right = v.segs[v.segs.length - 1].right;
  });

  const maxRight = Math.max(0, ...vlines.map((v) => v.right));
  const rightHits = vlines.filter((v) => v.right >= maxRight - 0.03 * width).length; // wrapped text has several lines on the margin
  const damaged = lines.reduce((a, l) => a + damagedCount(l.str), 0);
  const minLeft = Math.min(width, ...vlines.map((v) => v.left));

  // ---- tables: runs of consecutive multi-cell lines with shared column starts
  const blocks = [];
  let i = 0;
  // Columns of a block of rows. Preferred: x-ranges that stay empty (gutters) in
  // every row, which handles left- and right-aligned columns alike. Fallback:
  // shared left edges, for fonts whose reported widths overlap their neighbours.
  const clusterCols = (rows) => {
    const iv = rows.flatMap((r) => r.cells.map((c) => [c.x, c.right])).sort((a, b) => a[0] - b[0]);
    const cols = [];
    iv.forEach(([x0, x1]) => {
      const c = cols[cols.length - 1];
      if (c && x0 - c.right < 8) { c.right = Math.max(c.right, x1); c.n++; } else cols.push({ x: x0, right: x1, n: 1 });
    });
    const strong = cols.filter((c) => c.n >= 2);
    if (strong.length >= 2) return strong;
    const xs = rows.flatMap((r) => r.cells.map((c) => c.x)).sort((a, b) => a - b);
    const lefts = [];
    xs.forEach((x) => { const c = lefts[lefts.length - 1]; if (c && x - c.x < 10) c.n++; else lefts.push({ x, n: 1, right: x }); });
    return lefts;
  };
  while (i < vlines.length) {
    let j = i;
    while (j < vlines.length && vlines[j].cells.length >= 2 && (j === i || vlines[j].base - vlines[j - 1].base < vlines[j].size * 2.6)) j++;
    const rows = vlines.slice(i, j);
    const cols = rows.length >= 2 ? clusterCols(rows).filter((c) => c.n >= 2) : [];
    if (rows.length >= 2 && cols.length >= 2) {
      blocks.push({ type: 'table', top: rows[0].base - rows[0].size, base: rows[0].base, rows, cols });
      i = j;
    } else {
      blocks.push({ type: 'line', top: vlines[i].base - vlines[i].size, v: vlines[i] });
      i++;
    }
  }

  // ---- paragraphs: wrapped lines merge when they continue each other
  const out = [];
  blocks.forEach((b) => {
    if (b.type === 'table') { out.push(b); return; }
    const v = b.v;
    const runs = [];
    v.cells.forEach((c, ci) => c.runs.forEach((r, ri) => runs.push({ ...r, lead: ci > 0 && ri === 0 ? '    ' : '' })));
    const para = { type: 'para', top: b.top, base: v.base, size: v.size, left: v.left, right: v.right, runs, lines: 1 };
    const p = out[out.length - 1];
    const sameStyle = p && p.type === 'para' && Math.abs(p.size - para.size) < 0.7 && p.runs[p.runs.length - 1].bold === runs[0].bold;
    const wraps = sameStyle && para.base - p.base < Math.max(para.size * 1.7, 4) && Math.abs(p.left - para.left) < 4 && rightHits >= 3 && p.right >= maxRight - 0.03 * width && p.runs.length === 1 && runs.length === 1;
    if (wraps) {
      const last = p.runs[p.runs.length - 1];
      last.str = glue(last.str, runs[0].str, p.size, p.size);
      p.base = para.base; p.right = Math.max(p.right, para.right); p.lines++;
    } else out.push(para);
  });

  const imgs = images ? await pageImages(page, vp, canvas, SCALE) : [];
  imgs.forEach((im) => out.push({ type: 'image', top: im.y, base: im.y + im.h, x: im.x, w: im.w, h: im.h, canvas: im.canvas }));
  out.sort((a, b) => a.top - b.top || (a.left || a.x || 0) - (b.left || b.x || 0));
  return { width, height, marginLeft: minLeft, maxRight, blocks: out, damaged };
}

// the column whose x-range is nearest to a cell (works for left- and right-aligned columns)
const colIndex = (cols, c) => {
  const mid = (c.x + c.right) / 2;
  let best = 0, bd = Infinity;
  cols.forEach((col, k) => {
    const d = mid < col.x ? col.x - mid : mid > col.right ? mid - col.right : 0;
    if (d < bd) { bd = d; best = k; }
  });
  return best;
};

// ------------------------------------------------------------------- docx
const tw = (pt) => Math.round(pt * 20);
const FONT_ATTR = (f) => `<w:rFonts w:ascii="${esc(f)}" w:hAnsi="${esc(f)}" w:cs="${esc(f)}" w:eastAsia="${esc(f)}"/>`;
const runXml = (r, text) => {
  const sz = Math.max(2, Math.round(r.size * 2));
  const props = `${FONT_ATTR(r.family)}${r.bold ? '<w:b/><w:bCs/>' : ''}${r.italic ? '<w:i/><w:iCs/>' : ''}${r.color ? `<w:color w:val="${r.color}"/>` : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
};
const runsXml = (runs) => runs.map((r, k) => {
  const prev = runs[k - 1];
  const text = (r.lead || '') + ((prev && !r.lead && (prev.sp || (r.gap > r.size * 0.14 && !(THAI.test(prev.str.slice(-1)) && THAI.test(r.str[0]) && r.gap < r.size * 0.15))) && !/\s$/.test(prev.str)) ? ' ' : '') + r.str;
  return runXml(r, text);
}).join('');

export async function buildDocx(pages, title) {
  const zip = new JSZip();
  const media = [];
  let body = '';
  let rid = 1, picId = 1;
  const first = pages[0] || { width: 595, height: 842, marginLeft: 56, maxRight: 540 };
  const mL = Math.min(Math.max(first.marginLeft, 18), 140);
  const mR = Math.min(Math.max(first.width - first.maxRight, 18), 140);
  const mT = 40, mB = 40;
  pages.forEach((pg, pi) => {
    let prevBase = null, firstOnPage = true;
    const pageBreak = pi > 0;
    const flagBreak = () => { const f = firstOnPage && pageBreak; firstOnPage = false; return f; };
    pg.blocks.forEach((b) => {
      const before = prevBase == null ? Math.max(0, b.top - mT) : Math.max(0, b.base - prevBase - (b.size || 10) * 1.2);
      if (b.type === 'para') {
        const mid = (b.left + b.right) / 2;
        let jc = 'left';
        if (Math.abs(mid - pg.width / 2) < pg.width * 0.025 && b.left > pg.marginLeft + 12 && b.right < pg.maxRight - 12) jc = 'center';
        else if (Math.abs(b.right - pg.maxRight) < 5 && b.left > pg.marginLeft + 0.3 * pg.width) jc = 'right';
        const ind = jc === 'left' ? Math.max(0, b.left - mL) : 0;
        body += `<w:p><w:pPr>${flagBreak() ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="${tw(Math.min(before, 200))}" w:after="0"/>${ind > 2 ? `<w:ind w:left="${tw(ind)}"/>` : ''}<w:jc w:val="${jc}"/></w:pPr>${runsXml(b.runs)}</w:p>`;
        prevBase = b.base;
      } else if (b.type === 'table') {
        const cols = b.cols;
        const right = pg.maxRight;
        const widths = cols.map((c, k) => (k + 1 < cols.length ? cols[k + 1].x : right) - c.x);
        let rowsXml = '';
        b.rows.forEach((row) => {
          const cells = cols.map(() => []);
          row.cells.forEach((c) => {
            cells[colIndex(cols, c)].push(c);
          });
          rowsXml += `<w:tr>${cells.map((cs, k) => `<w:tc><w:tcPr><w:tcW w:w="${tw(Math.max(20, widths[k]))}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${runsXml(cs.flatMap((c) => c.runs))}</w:p></w:tc>`).join('')}</w:tr>`;
        });
        const lead = flagBreak() ? '<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>' : '';
        const indent = Math.max(0, cols[0].x - mL);
        body += `${lead}<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblInd w:w="${tw(indent)}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${tw(Math.max(20, w))}"/>`).join('')}</w:tblGrid>${rowsXml}</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`;
        const lastRow = b.rows[b.rows.length - 1];
        prevBase = lastRow.base;
      } else if (b.type === 'image') {
        const id = `rId${100 + rid++}`;
        const name = `image${media.length + 1}.png`;
        media.push({ id, name, canvas: b.canvas });
        const cx = Math.round(b.w * 12700), cy = Math.round(b.h * 12700);
        const ind = Math.max(0, b.x - mL);
        body += `<w:p><w:pPr>${flagBreak() ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="${tw(Math.min(before, 200))}" w:after="0"/>${ind > 2 ? `<w:ind w:left="${tw(ind)}"/>` : ''}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${picId}" name="Picture ${picId}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${picId}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
        picId++;
        prevBase = b.base;
      }
    });
  });
  if (!body) body = '<w:p/>';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="${tw(first.width)}" w:h="${tw(first.height)}"/><w:pgMar w:top="${tw(mT)}" w:right="${tw(mR)}" w:bottom="${tw(mB)}" w:left="${tw(mL)}" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>upmypdf.com</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`);
  zip.file('word/document.xml', doc);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map((m) => `<Relationship Id="${m.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`);
  for (const m of media) {
    const blob = await new Promise((res) => m.canvas.toBlob(res, 'image/png'));
    zip.file(`word/media/${m.name}`, await blob.arrayBuffer());
  }
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
}

// ------------------------------------------------------------ excel / text
// Rows of cells per page: columns come from clustering cell start positions
// across the whole page, so figures line up in the same column.
export function pageToRows(pg) {
  const rows = [];
  const cellText = (runs) => runs.reduce((a, r, i) => (i ? glue(a, r.str, r.gap || 0, r.size, runs[i - 1] && runs[i - 1].sp) : r.str), '').replace(/\s+/g, ' ').trim();
  const val = (t) => (NUM.test(t) ? Number(t.replace(/[,฿$€£%\s]/g, '').replace(/^\((.*)\)$/, '-$1').replace('−', '-')) : t);
  pg.blocks.forEach((b) => {
    if (b.type === 'para') rows.push([cellText(b.runs)]);
    else if (b.type === 'table') {
      b.rows.forEach((r) => {
        const row = b.cols.map(() => '');
        r.cells.forEach((c) => {
          const k = colIndex(b.cols, c);
          const t = cellText(c.runs);
          row[k] = row[k] === '' ? val(t) : `${row[k]} ${t}`;
        });
        rows.push(row);
      });
    }
  });
  return rows;
}

export function pageToText(pg) {
  const out = [];
  pg.blocks.forEach((b) => {
    if (b.type === 'para') out.push(b.runs.reduce((a, r, i) => (i ? glue(a, (r.lead || '') + r.str, r.gap || 0, r.size) : r.str), ''));
    else if (b.type === 'table') b.rows.forEach((r) => out.push(r.cells.map((c) => c.runs.reduce((a, rr, i) => (i ? glue(a, rr.str, rr.gap || 0, rr.size) : rr.str), '')).join('   ')));
  });
  return out;
}

export async function analyzeDocument(src, onPage, opts) {
  const pages = [];
  for (let i = 1; i <= src.numPages; i++) {
    if (onPage) onPage(i, src.numPages);
    pages.push(await analyzePage(await src.getPage(i), opts));
  }
  return pages;
}
