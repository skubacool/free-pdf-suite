// Auto-detect where the blanks are on a flat (non-fillable) form: underlines,
// empty boxes, check boxes and dotted leaders. It looks at the rendered page
// pixels plus the page's own text, then names each field after the label next
// to it ("Name", "Date of birth", "ชื่อ-สกุล"). Everything is a suggestion the
// user reviews in the Create Form list before the form is built.
import { extractLines, rangeBox, lineBox } from './textlayer.js';

const SCALE = 2;
const DARK = 150;

export async function detectFields(page) {
  const vp = page.getViewport({ scale: SCALE });
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const px = ctx.getImageData(0, 0, W, H).data;
  const dark = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) dark[j] = (px[i] + px[i + 1] + px[i + 2]) / 3 < DARK ? 1 : 0;

  const found = []; // in raster px: {kind, x, y, w, h}

  // fraction of dark pixels along each side of a bbox: a drawn rectangle has four
  // solid sides, a letter like O or D does not
  const sides = (x, y, w, h) => {
    const edge = (x0, y0, x1, y1) => {
      let n = 0, d = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { n++; if (dark[yy * W + xx]) d++; }
      return d / n;
    };
    const t = 2;
    return Math.min(edge(x, y, x + w - 1, Math.min(y + t - 1, y + h - 1)), edge(x, Math.max(y, y + h - t), x + w - 1, y + h - 1), edge(x, y, Math.min(x + t - 1, x + w - 1), y + h - 1), edge(Math.max(x, x + w - t), y, x + w - 1, y + h - 1));
  };

  // ---- 1. connected components -> boxes and check boxes
  const seen = new Uint8Array(W * H);
  const stack = [];
  for (let start = 0; start < dark.length; start++) {
    if (!dark[start] || seen[start]) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, count = 0;
    stack.length = 0; stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && dark[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && dark[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && dark[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && dark[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const fill = count / (w * h);
    if (w >= 14 && w <= 44 && h >= 14 && h <= 44 && Math.abs(w - h) <= 0.2 * Math.max(w, h) && fill < 0.5 && sides(minX, minY, w, h) > 0.8) {
      found.push({ kind: 'check', x: minX, y: minY, w, h });
      for (let yy = minY; yy <= maxY; yy++) for (let xx = minX; xx <= maxX; xx++) dark[yy * W + xx] = 0; // do not re-read as lines
    } else if (h >= 22 && h <= 110 && w >= 90 && w < W * 0.92 && fill < 0.14 && sides(minX, minY, w, h) > 0.8) {
      found.push({ kind: h > 70 ? 'multi' : 'text', x: minX + 3, y: minY + 3, w: w - 6, h: h - 6 });
      for (let yy = minY; yy <= maxY; yy++) for (let xx = minX; xx <= maxX; xx++) dark[yy * W + xx] = 0;
    } else if (h >= 110 && w >= 200 && w < W * 0.92 && h < H * 0.7 && fill < 0.04 && sides(minX, minY, w, h) > 0.8) {
      found.push({ kind: 'multi', x: minX + 3, y: minY + 3, w: w - 6, h: h - 6 });
      for (let yy = minY; yy <= maxY; yy++) for (let xx = minX; xx <= maxX; xx++) dark[yy * W + xx] = 0;
    }
  }

  // ---- 2. horizontal runs -> underlines (only with free space above to type in)
  const MIN_RUN = 80;
  const runs = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!dark[y * W + x]) { x++; continue; }
      let e = x;
      while (e < W && dark[y * W + e]) e++;
      if (e - x >= MIN_RUN) runs.push({ x, e, y });
      x = e;
    }
  }
  // merge runs on neighbouring rows (a thick line) into one
  const lines = [];
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  runs.forEach((r) => {
    const m = lines.find((l) => r.y - l.y1 <= 2 && Math.abs(r.x - l.x) < 12 && Math.abs(r.e - l.e) < 12);
    if (m) { m.y1 = r.y; m.x = Math.min(m.x, r.x); m.e = Math.max(m.e, r.e); } else lines.push({ x: r.x, e: r.e, y0: r.y, y1: r.y });
  });
  lines.forEach((l) => {
    const thick = l.y1 - l.y0 + 1;
    if (thick > 6) return;
    const above = 36; // 18pt of room to type
    let inkAbove = 0, total = 0;
    for (let y = Math.max(0, l.y0 - above); y < l.y0 - 2; y++) for (let x = l.x; x < l.e; x++) { total++; if (dark[y * W + x]) inkAbove++; }
    if (total && inkAbove / total > 0.06) return; // text already sits on it: not a blank
    found.push({ kind: 'text', x: l.x, y: Math.max(0, l.y0 - above), w: l.e - l.x, h: above - 2 });
  });

  // ---- 3. dotted / underscore leaders from the page's text
  const { lines: tl } = await extractLines(page, { measure: true, split: true });
  const pts = (r) => ({ x: r.x * SCALE, y: r.top * SCALE, w: r.w * SCALE, h: r.h * SCALE });
  tl.forEach((ln) => {
    const re = /(?:\.{6,}|…{3,}|_{4,}|…{3,})/g;
    let m;
    while ((m = re.exec(ln.str))) {
      const box = rangeBox(ln, m.index, m.index + m[0].length);
      if (!box || box.w < 30) continue;
      const q = pts({ x: box.x, w: box.w, top: ln.base - ln.size * 1.0, h: ln.size * 1.25 });
      found.push({ kind: 'text', x: q.x, y: q.y, w: q.w, h: q.h });
    }
  });

  // ---- de-duplicate overlapping suggestions
  const keep = [];
  found.sort((a, b) => b.w * b.h - a.w * a.h).forEach((f) => {
    const dup = keep.some((k) => {
      const ox = Math.max(0, Math.min(k.x + k.w, f.x + f.w) - Math.max(k.x, f.x));
      const oy = Math.max(0, Math.min(k.y + k.h, f.y + f.h) - Math.max(k.y, f.y));
      return ox * oy > 0.4 * Math.min(k.w * k.h, f.w * f.h);
    });
    if (!dup) keep.push(f);
  });

  // ---- name each field from the nearest label
  const label = (f) => {
    const fx = f.x / SCALE, fy = f.y / SCALE, fw = f.w / SCALE, fh = f.h / SCALE;
    const mid = fy + fh / 2, bottom = fy + fh;
    let best = null, bd = 1e9;
    tl.forEach((ln) => {
      const lb = lineBox(ln);
      const rowGap = Math.abs(lb.top + lb.h / 2 - mid);
      if (rowGap > ln.size * 0.95) return;
      // a dotted leader that is part of "Phone: ........" is labelled by the words before it
      const inside = fx >= lb.x - 2 && fx < lb.x + lb.w;
      const text = (inside ? ln.str.split(/[._…]{4,}/)[0] : ln.str);
      const t = text.replace(/[._…:\s]+$/g, '').replace(/^[\s☐□]+/, '').trim();
      if (!t || /^[._…\s]+$/.test(ln.str)) return;
      if (f.kind === 'check') {
        const d = lb.x - (fx + fw);
        if (d > -4 && d < 60 && d < bd) { best = t; bd = d; }
      } else if (inside) {
        if (0 < bd) { best = t; bd = 0; }
      } else {
        const d = fx - (lb.x + lb.w);
        if (d > -6 && d < 220 && d < bd) { best = t; bd = d; }
      }
    });
    if (!best) { // label directly above
      tl.forEach((ln) => {
        const lb = lineBox(ln);
        const d = fy - (lb.top + lb.h);
        if (d > -4 && d < 26 && lb.x < fx + fw && lb.x + lb.w > fx - 10 && d < bd) { best = ln.str.replace(/[:\s]+$/g, '').trim(); bd = d; }
      });
    }
    return best;
  };

  return keep.map((f) => ({
    type: f.kind,
    x: f.x / W, y: f.y / H, w: f.w / W, h: f.h / H,
    label: (label(f) || '').slice(0, 40),
  })).sort((a, b) => a.y - b.y || a.x - b.x);
}
