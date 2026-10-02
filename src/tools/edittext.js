// Edit PDF Text — click an existing line of text on the page, retype it, and
// download. Nothing leaves the browser.
//
// How it works (honest version): a PDF stores text as positioned glyphs, not as
// a re-flowable paragraph, so there is no reliable way to rewrite those glyphs
// in place. Instead each edited page is rendered to an image, the old words are
// erased by rebuilding the background from the pixels around them (the same
// blend Smart Erase uses), and the new words are painted on top in a matching
// size and colour. Pages you did not touch are copied across untouched, so they
// stay sharp, selectable vector pages. The edited page itself becomes an image.
import { blendFill } from './erase.js';

const FAMILIES = {
  sans: 'Arial,Helvetica,"Sarabun","Noto Sans Thai","Segoe UI",sans-serif',
  serif: '"Times New Roman",Times,"Noto Serif Thai","Noto Sans Thai",serif',
  mono: '"Courier New",Courier,monospace',
};

export function initEditText() {
  const { $, $$, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, canvasToJpeg, renderPreview, PDFLib } = window.appHelpers;
  const { PDFDocument } = PDFLib;
  if (!$('#dz-edittext')) return;

  const st = { file: null, doc: null, pageNum: 1, segs: {}, edits: {}, sel: null };
  const wrap = () => $('#wrap-edittext');
  const countEdits = () => Object.values(st.edits).reduce((a, m) => a + Object.keys(m).length, 0);
  const updateReady = () => {
    $('#btn-edittext').disabled = !(st.file && countEdits() > 0);
    $('#et-count').textContent = countEdits() ? `${countEdits()} line${countEdits() > 1 ? 's' : ''} changed` : '';
  };

  // ---- find the editable lines on a page (merge neighbouring pdf.js runs)
  const guessStyle = (page, fontName, styleFamily) => {
    let name = '';
    try { name = (page.commonObjs.get(fontName) || {}).name || ''; } catch (_) {}
    const probe = `${name} ${styleFamily || ''}`;
    return {
      bold: /bold|black|heavy|semibold|demi/i.test(probe),
      family: /mono|courier|consolas/i.test(probe) ? 'mono' : /(^|[^a-z])(serif)|times|georgia|garamond|minion|cambria|palatino|book/i.test(probe) && !/sans/i.test(probe) ? 'serif' : 'sans',
    };
  };
  const loadSegs = async (num) => {
    if (st.segs[num]) return st.segs[num];
    const page = await st.doc.getPage(num);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.str.length) continue;
      const t = window.pdfjsLib.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(t[2], t[3]);
      if (!size || Math.abs(t[1]) > 0.02 * Math.abs(t[0])) continue; // skip rotated runs
      const style = tc.styles[it.fontName] || {};
      items.push({ str: it.str, x: t[4], base: t[5], w: it.width, size, fontName: it.fontName, family: style.fontFamily });
    }
    const lines = [];
    let cur = null;
    for (const it of items) {
      const gap = cur ? it.x - (cur.x + cur.w) : 0;
      if (cur && Math.abs(it.base - cur.base) < 0.25 * cur.size && gap < 0.4 * cur.size && gap > -0.6 * cur.size && Math.abs(it.size - cur.size) < 0.18 * cur.size && it.fontName === cur.fontName) {
        cur.str += it.str; cur.w = it.x + it.w - cur.x;
      } else {
        if (cur) lines.push(cur);
        cur = { ...it };
      }
    }
    if (cur) lines.push(cur);
    const segs = lines.filter((l) => l.str.trim()).map((l, id) => {
      const g = guessStyle(page, l.fontName, l.family);
      return { id, text: l.str.replace(/\s+$/, ''), x: l.x / vp.width, w: l.w / vp.width, base: l.base / vp.height, size: l.size, pageW: vp.width, pageH: vp.height, ...g };
    });
    st.segs[num] = segs;
    return segs;
  };

  const drawSegs = async () => {
    const segs = await loadSegs(st.pageNum);
    $$('.et-seg', wrap()).forEach((m) => m.remove()); // after the await so overlapping calls cannot stack duplicates
    const ed = st.edits[st.pageNum] || {};
    segs.forEach((s) => {
      const d = document.createElement('div');
      d.dataset.id = s.id;
      d.className = 'et-seg' + (ed[s.id] ? ' edited' : '') + (st.sel && st.sel.page === st.pageNum && st.sel.id === s.id ? ' sel' : '');
      const h = s.size * 1.25 / s.pageH;
      d.style.cssText = `position:absolute;left:${(s.x - 0.004) * 100}%;top:${(s.base - s.size * 0.95 / s.pageH) * 100}%;width:${(s.w + 0.008) * 100}%;height:${h * 100}%;`;
      d.title = ed[s.id] ? `Changed to: ${ed[s.id].text}` : 'Click to edit this text';
      d.addEventListener('click', (e) => { e.stopPropagation(); select(s); });
      wrap().appendChild(d);
    });
    if (!segs.length) setStatus('edittext', '⚠️ No editable text found on this page. If it is a scan, run it through OCR first (Make Searchable) and come back.', 'error');
    else setStatus('edittext', 'Click any line of text to change it.');
  };

  // Update highlight classes in place. Rebuilding the overlay boxes while the
  // pointer is mid-click would swallow the click on another line.
  const refreshMarks = () => {
    const ed = st.edits[st.pageNum] || {};
    $$('.et-seg', wrap()).forEach((d) => {
      const id = +d.dataset.id;
      d.classList.toggle('edited', !!ed[id]);
      d.classList.toggle('sel', !!st.sel && st.sel.page === st.pageNum && st.sel.id === id);
      d.title = ed[id] ? `Changed to: ${ed[id].text}` : 'Click to edit this text';
    });
  };

  // ---- the little editor under the page
  const select = (s) => {
    st.sel = { page: st.pageNum, id: s.id };
    const e = (st.edits[st.pageNum] || {})[s.id];
    $('#et-editor').classList.remove('hidden');
    $('#et-text').value = e ? e.text : s.text;
    $('#et-size').value = Math.round((e ? e.size : s.size) * 10) / 10;
    $('#et-bold').checked = e ? e.bold : s.bold;
    $('#et-family').value = e ? e.family : s.family;
    $('#et-align').value = e ? e.align : 'left';
    $('#et-color').value = e && e.color ? e.color : '#000000';
    $('#et-usecolor').checked = !!(e && e.color);
    $('#et-orig').textContent = `Original: “${s.text}”`;
    refreshMarks();
    $('#et-text').focus();
  };
  const currentSeg = () => st.sel && (st.segs[st.sel.page] || []).find((s) => s.id === st.sel.id);
  const stage = () => {
    const s = currentSeg();
    if (!s) return;
    const text = $('#et-text').value;
    const m = (st.edits[st.sel.page] = st.edits[st.sel.page] || {});
    if (text === s.text && !m[s.id]) return; // nothing changed yet
    m[s.id] = { text, size: Math.max(2, +$('#et-size').value || s.size), bold: $('#et-bold').checked, family: $('#et-family').value, align: $('#et-align').value, color: $('#et-usecolor').checked ? $('#et-color').value : null };
    refreshMarks();
    updateReady();
  };
  ['et-text', 'et-size', 'et-bold', 'et-family', 'et-align', 'et-color', 'et-usecolor'].forEach((id) => {
    $(`#${id}`).addEventListener('input', stage);
    $(`#${id}`).addEventListener('change', stage);
  });
  $('#et-revert').addEventListener('click', () => {
    if (!st.sel) return;
    delete (st.edits[st.sel.page] || {})[st.sel.id];
    const s = currentSeg();
    if (s) select(s);
    updateReady();
  });

  const style = document.createElement('style');
  style.textContent = '.et-seg{cursor:text;border-radius:3px;transition:background .12s}.et-seg:hover{background:rgba(37,99,235,.14);outline:1px solid rgba(37,99,235,.55)}.et-seg.edited{background:rgba(16,185,129,.22);outline:1px solid #10b981}.et-seg.sel{outline:2px solid #2563eb;background:rgba(37,99,235,.18)}';
  document.head.appendChild(style);

  setupDropzone('edittext', async ([f]) => {
    try {
      st.file = f; st.segs = {}; st.edits = {}; st.sel = null; hideResult('edittext');
      $('#et-editor').classList.add('hidden');
      setStatus('edittext', 'Loading preview…');
      st.doc = await loadPdfJs(await f.arrayBuffer());
      st.pageNum = 1;
      $('#page-edittext').value = 1;
      $('#page-edittext').max = st.doc.numPages;
      $('#pages-edittext').textContent = `/ ${st.doc.numPages}`;
      $('#picked-edittext').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#work-edittext').classList.remove('hidden');
      await renderPreview(st, '#preview-edittext', '#wrap-edittext');
      await drawSegs();
    } catch (err) {
      setStatus('edittext', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
    }
    updateReady();
  });

  $('#page-edittext').addEventListener('change', async () => {
    if (!st.doc) return;
    st.pageNum = Math.min(Math.max(1, +$('#page-edittext').value || 1), st.doc.numPages);
    $('#page-edittext').value = st.pageNum;
    $('#et-editor').classList.add('hidden');
    await renderPreview(st, '#preview-edittext', '#wrap-edittext');
    await drawSegs();
  });

  // ---- apply: rasterize edited pages, erase the old words, paint the new
  const darkest = (ctx, x, y, w, h) => {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.max(1, Math.min(cw - x, Math.ceil(w))); h = Math.max(1, Math.min(ch - y, Math.ceil(h)));
    const d = ctx.getImageData(x, y, w, h).data;
    let best = 1e9, bi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] + d[i + 1] + d[i + 2];
      if (l < best) { best = l; bi = i; }
    }
    return `rgb(${d[bi]},${d[bi + 1]},${d[bi + 2]})`;
  };

  $('#btn-edittext').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    const btn = $('#btn-edittext');
    btn.disabled = true;
    hideResult('edittext');
    try {
      setStatus('edittext', 'Applying your edits…');
      const data = await f.arrayBuffer();
      const srcPdf = await loadPdfJs(data.slice(0));
      const srcDoc = await PDFDocument.load(data.slice(0));
      const out = await PDFDocument.create();
      try { await document.fonts.load('16px "Sarabun"'); await document.fonts.load('16px "Noto Sans Thai"'); } catch (_) {}
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const SCALE = 2.5;
      for (let i = 1; i <= srcPdf.numPages; i++) {
        const edits = st.edits[i] && Object.keys(st.edits[i]).length ? st.edits[i] : null;
        if (!edits) {
          const [p] = await out.copyPages(srcDoc, [i - 1]);
          out.addPage(p);
          continue;
        }
        const page = await srcPdf.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: SCALE });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        setTimeout(() => { try { page.cleanup(); } catch (e) {} }, 0);
        const segs = st.segs[i] || [];
        // Measure every colour first, then erase, then paint (a later erase must
        // not smear an earlier line's colour sample).
        const jobs = segs.filter((s) => edits[s.id]).map((s) => {
          const e = edits[s.id];
          const px = s.size * SCALE;
          const left = (s.x * canvas.width) - px * 0.12;
          const wpx = s.w * canvas.width + px * 0.24;
          const top = s.base * canvas.height - px * 1.0;
          const hpx = px * 1.35;
          const color = e.color || darkest(ctx, left, top, wpx, hpx);
          return { s, e, px, left, wpx, top, hpx, color };
        });
        jobs.forEach((j) => blendFill(ctx, canvas.width, canvas.height, j.left, j.top, j.wpx, j.hpx, 'auto'));
        jobs.forEach((j) => {
          const { s, e, px, color } = j;
          const size = e.size * SCALE;
          ctx.font = `${e.bold ? 'bold ' : ''}${size}px ${FAMILIES[e.family] || FAMILIES.sans}`;
          ctx.fillStyle = color;
          ctx.textBaseline = 'alphabetic';
          const w = ctx.measureText(e.text).width;
          const x0 = s.x * canvas.width, x1 = (s.x + s.w) * canvas.width;
          const x = e.align === 'right' ? x1 - w : e.align === 'center' ? (x0 + x1) / 2 - w / 2 : x0;
          ctx.fillText(e.text, x, s.base * canvas.height);
        });
        const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.92));
        out.addPage([vp1.width, vp1.height]).drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      }
      const bytes = await out.save({ useObjectStreams: true });
      const n = countEdits();
      showResult('edittext', bytes, `${baseName(f.name)}_edited.pdf`, 'application/pdf', `${n} line${n > 1 ? 's' : ''} changed · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('edittext', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = !(st.file && countEdits() > 0);
    }
  });
}
