// Smart Erase — removes a logo, stamp or watermark from a PDF page and fills
// the hole with a reconstruction of the surrounding background, instead of
// Redact's solid black box. Built for the common real case: a vendor logo or
// "Powered by X" footer stamped on an otherwise plain (or gently shaded)
// page, like the bottom corner of an invoice.
//
// How the fill works (no AI, no server, pure canvas pixels):
//   For every pixel inside the marked box, sample the strip of pixels just
//   outside each of the four edges, then blend a horizontal interpolation
//   (left edge -> right edge) with a vertical one (top edge -> bottom edge),
//   weighted toward whichever direction has the shorter span (a wide, short
//   box trusts its close top/bottom edges more than its far-apart left/right
//   ones). A touch of noise proportional to the measured edge grain keeps a
//   textured background (paper, a subtle gradient) from looking pasted-flat.
//   This reconstructs plain or gently-varying backgrounds convincingly; a
//   busy photographic background underneath the mark will come out smoothed
//   rather than perfectly rebuilt - there is no real content to recover from.
// Finished pages are rasterized (same trade-off as Redact and friends), but the
// page's remaining text is written back as an invisible layer so it can still be
// selected and searched. Text under an erased box is not written back.
// ---- the fill itself: directional-interpolation reconstruction ----------
// Exported so Edit Text can erase the old words the same way.
const STRIP = 6; // px of border sampled just outside each edge

const avgStrip = (data, w, h, x0, x1, y0, y1) => {
  // Colour of the clamped rectangle [x0,x1) x [y0,y1): per-channel MEDIAN first
  // (so a few dark pixels from neighbouring text cannot drag it). Stray glyph or
  // border pixels are ignored because they are the minority.
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
  const n = (x1 - x0) * (y1 - y0);
  if (n <= 0) return [255, 255, 255];
  const rs = [], gs = [], bs = [];
  for (let y = y0; y < y1; y++) {
    let i = (y * w + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) { rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); }
  }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  const mr = med(rs.slice()), mg = med(gs.slice()), mb = med(bs.slice());
  return [mr, mg, mb];
};

export const blendFill = (ctx, canvasW, canvasH, bx, by, bw, bh, mode, customColor) => {
  bx = Math.max(0, Math.round(bx)); by = Math.max(0, Math.round(by));
  bw = Math.max(1, Math.min(canvasW - bx, Math.round(bw)));
  bh = Math.max(1, Math.min(canvasH - by, Math.round(bh)));
  if (bw <= 0 || bh <= 0) return;

  if (mode === 'white' || mode === 'custom') {
    const hex = mode === 'white' ? '#ffffff' : (customColor || '#ffffff');
    ctx.fillStyle = hex;
    ctx.fillRect(bx, by, bw, bh);
    return;
  }

  const img = ctx.getImageData(0, 0, canvasW, canvasH);
  const data = img.data;

  // Flat background? If one colour makes up most of the ring just outside the
  // box (a plain white or tinted page), fill with exactly that colour. This is
  // what a clean invoice needs, and it ignores neighbouring glyph pixels.
  const ring = [[bx - STRIP, bx, by - STRIP, by + bh + STRIP], [bx + bw, bx + bw + STRIP, by - STRIP, by + bh + STRIP], [bx, bx + bw, by - STRIP, by], [bx, bx + bw, by + bh, by + bh + STRIP]];
  const buckets = new Map();
  let total = 0;
  ring.forEach(([x0, x1, y0, y1]) => {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(canvasW, x1); y1 = Math.min(canvasH, y1);
    for (let y = y0; y < y1; y++) {
      let i = (y * canvasW + x0) * 4;
      for (let x = x0; x < x1; x++, i += 4) {
        const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        const b = buckets.get(k) || [0, 0, 0, 0];
        b[0]++; b[1] += data[i]; b[2] += data[i + 1]; b[3] += data[i + 2];
        buckets.set(k, b); total++;
      }
    }
  });
  let top = null;
  buckets.forEach((b) => { if (!top || b[0] > top[0]) top = b; });
  if (top && total && top[0] / total >= 0.55) {
    ctx.fillStyle = `rgb(${Math.round(top[1] / top[0])},${Math.round(top[2] / top[0])},${Math.round(top[3] / top[0])})`;
    ctx.fillRect(bx, by, bw, bh);
    return;
  }

  // Per-row left/right edge colors, per-column top/bottom edge colors.
  // Averaged over a few neighbouring rows/cols too (not just STRIP deep)
  // so a single stray dark pixel at the boundary doesn't bleed a streak.
  const NEI = 2;
  const leftOf = new Array(bh), rightOf = new Array(bh);
  for (let y = 0; y < bh; y++) {
    const ay = by + y;
    leftOf[y] = avgStrip(data, canvasW, canvasH, bx - STRIP, bx, ay - NEI, ay + NEI + 1);
    rightOf[y] = avgStrip(data, canvasW, canvasH, bx + bw, bx + bw + STRIP, ay - NEI, ay + NEI + 1);
  }
  const topOf = new Array(bw), botOf = new Array(bw);
  for (let x = 0; x < bw; x++) {
    const ax = bx + x;
    topOf[x] = avgStrip(data, canvasW, canvasH, ax - NEI, ax + NEI + 1, by - STRIP, by);
    botOf[x] = avgStrip(data, canvasW, canvasH, ax - NEI, ax + NEI + 1, by + bh, by + bh + STRIP);
  }

  // Edge "grain": how much the border pixels vary, used to add back a
  // little matching noise instead of a dead-flat fill on textured paper.
  let variance = 0, vn = 0;
  const sampleVar = (x0, x1, y0, y1) => {
    const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(canvasW, x1), cy1 = Math.min(canvasH, y1);
    const [mr, mg, mb] = avgStrip(data, canvasW, canvasH, x0, x1, y0, y1);
    for (let y = cy0; y < cy1; y++) {
      let i = (y * canvasW + cx0) * 4;
      for (let x = cx0; x < cx1; x++, i += 4) {
        const d3 = (data[i] - mr) ** 2 + (data[i + 1] - mg) ** 2 + (data[i + 2] - mb) ** 2;
        if (Math.abs(data[i] - mr) + Math.abs(data[i + 1] - mg) + Math.abs(data[i + 2] - mb) >= 24) continue; // glyph/border pixels are not grain
        variance += d3;
        vn++;
      }
    }
  };
  sampleVar(bx - STRIP, bx, by, by + bh);
  sampleVar(bx + bw, bx + bw + STRIP, by, by + bh);
  let grain = Math.min(10, Math.sqrt((variance / Math.max(1, vn)) / 3) * 0.35);
  if (grain < 1.2) grain = 0; // a clean flat background stays clean

  const wV = bw / (bw + bh), wH = bh / (bw + bh); // trust the closer pair of edges more
  const out = new Uint8ClampedArray(bw * bh * 3);
  for (let y = 0; y < bh; y++) {
    const ty = bh > 1 ? y / (bh - 1) : 0.5;
    const [lr, lg, lb] = leftOf[y], [rr, rg, rb] = rightOf[y];
    for (let x = 0; x < bw; x++) {
      const tx = bw > 1 ? x / (bw - 1) : 0.5;
      const [tr, tg, tb] = topOf[x], [brr, brg, brb] = botOf[x];
      const hr = lr + (rr - lr) * tx, hg = lg + (rg - lg) * tx, hb = lb + (rb - lb) * tx;
      const vr = tr + (brr - tr) * ty, vg = tg + (brg - tg) * ty, vb = tb + (brb - tb) * ty;
      const j = (y * bw + x) * 3;
      const n = grain ? (Math.random() - 0.5) * grain : 0;
      out[j] = hr * wH + vr * wV + n;
      out[j + 1] = hg * wH + vg * wV + n;
      out[j + 2] = hb * wH + vb * wV + n;
    }
  }
  for (let y = 0; y < bh; y++) {
    let di = ((by + y) * canvasW + bx) * 4, si = y * bw * 3;
    for (let x = 0; x < bw; x++, di += 4, si += 3) {
      data[di] = out[si]; data[di + 1] = out[si + 1]; data[di + 2] = out[si + 2];
    }
  }
  ctx.putImageData(img, 0, 0, bx, by, bw, bh);
};


import { extractLines, addTextLayer, lineBox, boxesOverlap } from './textlayer.js';

export function initErase() {
  const { $, $$, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, canvasToJpeg, renderPreview, PDFLib } = window.appHelpers;
  const { PDFDocument } = PDFLib;
  if (!$('#dz-erase')) return;

  const st = { file: null, doc: null, pageNum: 1, rects: {}, mode: 'auto', color: '#ffffff' };
  const wrap = () => $('#wrap-erase');
  const countRects = () => Object.values(st.rects).reduce((a, r) => a + r.length, 0);
  const updateReady = () => {
    $('#btn-erase').disabled = !(st.file && countRects() > 0);
    if ($('#erase-count')) $('#erase-count').textContent = countRects() ? `${countRects()} area${countRects() > 1 ? 's' : ''} marked` : '';
  };
  const drawBoxes = () => {
    $$('.erase-box', wrap()).forEach((m) => m.remove());
    (st.rects[st.pageNum] || []).forEach((r, idx) => {
      const d = document.createElement('div');
      d.className = 'erase-box';
      d.style.cssText = `position:absolute;left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;background:repeating-linear-gradient(45deg,rgba(236,72,153,.22),rgba(236,72,153,.22) 6px,rgba(236,72,153,.38) 6px,rgba(236,72,153,.38) 12px);border:1.5px dashed #db2777;cursor:pointer;`;
      d.title = 'Click to remove this area';
      d.addEventListener('click', (e) => { e.stopPropagation(); st.rects[st.pageNum].splice(idx, 1); drawBoxes(); updateReady(); });
      wrap().appendChild(d);
    });
  };

  setupDropzone('erase', async ([f]) => {
    try {
      st.file = f; st.rects = {}; hideResult('erase');
      setStatus('erase', 'Loading preview…');
      st.doc = await loadPdfJs(await f.arrayBuffer());
      st.pageNum = 1;
      $('#page-erase').value = 1;
      $('#page-erase').max = st.doc.numPages;
      $('#pages-erase').textContent = `/ ${st.doc.numPages}`;
      $('#picked-erase').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#work-erase').classList.remove('hidden');
      await renderPreview(st, '#preview-erase', '#wrap-erase');
      drawBoxes();
      setStatus('erase', 'Drag across the page to mark what to erase. Click a marked area to undo it.');
    } catch (err) {
      setStatus('erase', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
    }
    updateReady();
  });

  $('#page-erase').addEventListener('change', async () => {
    if (!st.doc) return;
    st.pageNum = Math.min(Math.max(1, +$('#page-erase').value || 1), st.doc.numPages);
    $('#page-erase').value = st.pageNum;
    await renderPreview(st, '#preview-erase', '#wrap-erase');
    drawBoxes();
  });

  // ---- fill-mode picker: auto-blend (default) / white / custom color
  $$('[data-erasemode]').forEach((b) => b.addEventListener('click', () => {
    st.mode = b.dataset.erasemode;
    $$('[data-erasemode]').forEach((x) => x.classList.toggle('bg-brand-50', x === b));
    $$('[data-erasemode]').forEach((x) => x.classList.toggle('border-brand-600', x === b));
    $('#erase-color-row')?.classList.toggle('hidden', st.mode !== 'custom');
  }));
  $('#erase-color')?.addEventListener('input', (e) => { st.color = e.target.value; });

  // ---- drag-to-mark, same interaction as Redact
  let dragStart = null, ghost = null;
  const relPos = (e) => {
    const rect = $('#preview-erase').getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) };
  };
  $('#preview-erase').addEventListener('pointerdown', (e) => {
    if (!st.doc) return;
    dragStart = relPos(e);
    $('#preview-erase').setPointerCapture(e.pointerId);
    ghost = document.createElement('div');
    ghost.className = 'erase-box';
    ghost.style.cssText = 'position:absolute;background:rgba(236,72,153,.25);border:1.5px dashed #db2777;';
    wrap().appendChild(ghost);
  });
  $('#preview-erase').addEventListener('pointermove', (e) => {
    if (!dragStart || !ghost) return;
    const p = relPos(e);
    const x = Math.min(dragStart.x, p.x), y = Math.min(dragStart.y, p.y);
    const w = Math.abs(p.x - dragStart.x), h = Math.abs(p.y - dragStart.y);
    ghost.style.left = `${x * 100}%`; ghost.style.top = `${y * 100}%`;
    ghost.style.width = `${w * 100}%`; ghost.style.height = `${h * 100}%`;
  });
  const finishDrag = (e) => {
    if (!dragStart) return;
    const p = relPos(e);
    const x = Math.min(dragStart.x, p.x), y = Math.min(dragStart.y, p.y);
    const w = Math.abs(p.x - dragStart.x), h = Math.abs(p.y - dragStart.y);
    if (ghost) { ghost.remove(); ghost = null; }
    dragStart = null;
    if (w > 0.008 && h > 0.008) {
      (st.rects[st.pageNum] = st.rects[st.pageNum] || []).push({ x, y, w, h });
      drawBoxes();
      updateReady();
      setStatus('erase', '');
    }
  };
  $('#preview-erase').addEventListener('pointerup', finishDrag);
  $('#preview-erase').addEventListener('pointercancel', finishDrag);

  $('#btn-erase').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    const btn = $('#btn-erase');
    btn.disabled = true;
    hideResult('erase');
    try {
      setStatus('erase', 'Erasing and blending…');
      const src = await loadPdfJs(await f.arrayBuffer());
      const out = await PDFDocument.create();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      for (let i = 1; i <= src.numPages; i++) {
        const page = await src.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 2 });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        setTimeout(() => { try { page.cleanup(); } catch (e) {} }, 0);
        (st.rects[i] || []).forEach((r) => {
          blendFill(ctx, canvas.width, canvas.height, r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height, st.mode, st.color);
        });
        const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.9));
        const outPage = out.addPage([vp1.width, vp1.height]);
        outPage.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        // keep the rest of the page's text selectable; anything under an erased
        // box is left OUT of the layer so the erased words are really gone
        try {
          const gone = (st.rects[i] || []).map((r) => ({ x: r.x * vp1.width, w: r.w * vp1.width, top: r.y * vp1.height, h: r.h * vp1.height }));
          const { lines } = await extractLines(page, { split: true });
          const keep = lines.filter((l) => !gone.some((g) => boxesOverlap(lineBox(l), g))).map((l) => ({ text: l.str, x: l.x, w: l.w, base: l.base, size: l.size }));
          await addTextLayer(out, outPage, vp1.height, keep);
        } catch (e) { console.warn('[upmypdf] text layer skipped:', e && e.message); }
      }
      const bytes = await out.save({ useObjectStreams: true });
      const n = countRects();
      showResult('erase', bytes, `${baseName(f.name)}_erased.pdf`, 'application/pdf', `${n} area${n > 1 ? 's' : ''} erased and blended.`);
    } catch (err) {
      setStatus('erase', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = !st.file;
    }
  });
}
