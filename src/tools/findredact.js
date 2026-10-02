// Find & Redact — search a PDF for sensitive data (Thai ID numbers, phone
// numbers, e-mail addresses, card numbers, or any words/patterns you type),
// review every match on the page, and black them all out permanently.
//
// Redacted pages are re-drawn as images with the black boxes burned in, so the
// hidden words no longer exist in the file; the rest of each redacted page keeps
// an invisible text layer so it stays selectable. Pages with no matches are
// copied across untouched. Matching works on the PDF's real text, so a scanned
// page (a picture of text) has nothing to find: run OCR first.
import { extractLines, rangeBox, addTextLayer } from './textlayer.js';

const PATTERNS = {
  thaiid: { label: 'Thai ID number', re: /(?<!\d)\d[ -]?\d{4}[ -]?\d{5}[ -]?\d{2}[ -]?\d(?!\d)/g },
  phone: { label: 'Phone number', re: /(?<!\d)(?:\+66[ -]?\d{1,2}|0\d{1,2})[ -]?\d{3}[ -]?\d{4}(?!\d)/g },
  email: { label: 'E-mail address', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  card: { label: 'Card / account number', re: /(?<!\d)(?:\d[ -]?){12,15}\d(?!\d)/g },
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function initFindRedact() {
  const { $, $$, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, canvasToJpeg, renderPreview, PDFLib } = window.appHelpers;
  const { PDFDocument } = PDFLib;
  if (!$('#dz-findredact')) return;

  const st = { file: null, doc: null, pageNum: 1, matches: [], pages: {}, found: false };
  const wrap = () => $('#wrap-findredact');
  const active = () => st.matches.filter((m) => m.on);
  const updateReady = () => {
    const n = active().length;
    $('#btn-findredact').disabled = !(st.file && n);
    $('#btn-findredact').textContent = n ? `Redact ${n} Match${n > 1 ? 'es' : ''}` : 'Redact Matches';
  };

  const drawBoxes = () => {
    $$('.fr-box', wrap()).forEach((m) => m.remove());
    const dim = st.pages[st.pageNum];
    if (!dim) return;
    st.matches.filter((m) => m.page === st.pageNum).forEach((m) => {
      const d = document.createElement('div');
      d.className = 'fr-box';
      d.title = `${m.on ? 'Will be redacted' : 'Kept'}: ${m.text} — click to toggle`;
      d.style.cssText = `position:absolute;left:${(m.x / dim.w) * 100}%;top:${(m.top / dim.h) * 100}%;width:${(m.w / dim.w) * 100}%;height:${(m.h / dim.h) * 100}%;cursor:pointer;` +
        (m.on ? 'background:rgba(15,23,42,.78);border:1.5px solid #0f172a;' : 'background:rgba(16,185,129,.12);border:1.5px dashed #10b981;');
      d.addEventListener('click', (e) => { e.stopPropagation(); m.on = !m.on; drawBoxes(); renderSummary(); updateReady(); });
      wrap().appendChild(d);
    });
  };
  const renderSummary = () => {
    const el = $('#fr-summary');
    if (!st.found) { el.textContent = ''; return; }
    if (!st.matches.length) { el.textContent = 'No matches found in the text of this PDF.'; return; }
    const pages = new Set(st.matches.map((m) => m.page)).size;
    el.textContent = `${st.matches.length} match${st.matches.length > 1 ? 'es' : ''} on ${pages} page${pages > 1 ? 's' : ''} — ${active().length} will be redacted. Click a box on the page to keep or redact it.`;
  };

  const readTerms = () => {
    const useRe = $('#fr-regex').checked;
    const out = [];
    $$('[data-frpat]').forEach((c) => { if (c.checked) out.push({ re: PATTERNS[c.dataset.frpat].re, label: PATTERNS[c.dataset.frpat].label }); });
    $('#fr-terms').value.split('\n').map((t) => t.trim()).filter(Boolean).forEach((t) => {
      try { out.push({ re: new RegExp(useRe ? t : esc(t), 'gi'), label: t }); } catch (_) { throw new Error(`“${t}” is not a valid pattern.`); }
    });
    return out;
  };

  $('#fr-find').addEventListener('click', async () => {
    if (!st.doc) return;
    const btn = $('#fr-find');
    btn.disabled = true;
    try {
      const pats = readTerms();
      if (!pats.length) throw new Error('Tick a type of data to find, or type a word or pattern.');
      setStatus('findredact', 'Searching the text…');
      st.matches = []; st.found = false; hideResult('findredact');
      let anyText = false;
      for (let p = 1; p <= st.doc.numPages; p++) {
        const page = await st.doc.getPage(p);
        const { width, height, lines } = await extractLines(page, { measure: true });
        st.pages[p] = { w: width, h: height, lines };
        if (lines.length) anyText = true;
        lines.forEach((ln, li) => {
          const text = ln.str;
          const spans = [];
          pats.forEach(({ re }) => {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text))) {
              if (!m[0]) { re.lastIndex++; continue; }
              spans.push([m.index, m.index + m[0].length]);
            }
          });
          // merge overlapping spans from different patterns
          spans.sort((a, b) => a[0] - b[0]);
          const merged = [];
          spans.forEach((s) => { const l = merged[merged.length - 1]; if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else merged.push([...s]); });
          merged.forEach(([a, b]) => {
            const box = rangeBox(ln, a, b);
            if (!box) return;
            const pad = ln.size * 0.1;
            st.matches.push({ page: p, line: li, from: a, to: b, text: text.slice(a, b), x: box.x - pad, w: box.w + pad * 2, top: box.top, h: box.h, on: true });
          });
        });
      }
      st.found = true;
      renderSummary();
      if (!anyText) setStatus('findredact', '⚠️ This PDF has no text to search (it looks like a scan). Run it through OCR first, then come back.', 'error');
      else setStatus('findredact', st.matches.length ? '' : 'Nothing matched. Try different terms.');
      const first = st.matches[0];
      if (first && first.page !== st.pageNum) { st.pageNum = first.page; $('#page-findredact').value = first.page; await renderPreview(st, '#preview-findredact', '#wrap-findredact'); }
      drawBoxes();
    } catch (err) {
      setStatus('findredact', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = !st.doc;
      updateReady();
    }
  });

  setupDropzone('findredact', async ([f]) => {
    try {
      st.file = f; st.matches = []; st.pages = {}; st.found = false; hideResult('findredact');
      setStatus('findredact', 'Loading preview…');
      st.doc = await loadPdfJs(await f.arrayBuffer());
      st.pageNum = 1;
      $('#page-findredact').value = 1;
      $('#page-findredact').max = st.doc.numPages;
      $('#pages-findredact').textContent = `/ ${st.doc.numPages}`;
      $('#picked-findredact').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#work-findredact').classList.remove('hidden');
      $('#fr-find').disabled = false;
      await renderPreview(st, '#preview-findredact', '#wrap-findredact');
      const page1 = await st.doc.getPage(1);
      const vp = page1.getViewport({ scale: 1 });
      st.pages[1] = { w: vp.width, h: vp.height };
      renderSummary();
      setStatus('findredact', 'Choose what to look for, then press Find.');
    } catch (err) {
      setStatus('findredact', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
    }
    updateReady();
  });
  $('#page-findredact').addEventListener('change', async () => {
    if (!st.doc) return;
    st.pageNum = Math.min(Math.max(1, +$('#page-findredact').value || 1), st.doc.numPages);
    $('#page-findredact').value = st.pageNum;
    await renderPreview(st, '#preview-findredact', '#wrap-findredact');
    if (!st.pages[st.pageNum]) { const pg = await st.doc.getPage(st.pageNum); const v = pg.getViewport({ scale: 1 }); st.pages[st.pageNum] = { w: v.width, h: v.height }; }
    drawBoxes();
  });

  $('#btn-findredact').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    const btn = $('#btn-findredact');
    btn.disabled = true;
    hideResult('findredact');
    try {
      setStatus('findredact', 'Redacting…');
      const data = await f.arrayBuffer();
      const srcPdf = await loadPdfJs(data.slice(0));
      const srcDoc = await PDFDocument.load(data.slice(0));
      const out = await PDFDocument.create();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const SCALE = 2;
      const byPage = {};
      active().forEach((m) => (byPage[m.page] = byPage[m.page] || []).push(m));
      for (let i = 1; i <= srcPdf.numPages; i++) {
        const ms = byPage[i];
        if (!ms) { const [p] = await out.copyPages(srcDoc, [i - 1]); out.addPage(p); continue; }
        const page = await srcPdf.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: SCALE });
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        ctx.fillStyle = '#000000';
        ms.forEach((m) => ctx.fillRect(Math.floor(m.x * SCALE), Math.floor(m.top * SCALE), Math.ceil(m.w * SCALE), Math.ceil(m.h * SCALE)));
        const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.9));
        const outPage = out.addPage([vp1.width, vp1.height]);
        outPage.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        // rebuild the text layer without the redacted characters
        try {
          const { lines } = st.pages[i] && st.pages[i].lines ? { lines: st.pages[i].lines } : await extractLines(page);
          const layer = [];
          lines.forEach((ln, li) => {
            const cuts = ms.filter((m) => m.line === li).map((m) => [m.from, m.to]).sort((a, b) => a[0] - b[0]);
            let pos = 0;
            const pieces = [];
            cuts.forEach(([a, b]) => { if (a > pos) pieces.push([pos, a]); pos = Math.max(pos, b); });
            if (pos < ln.str.length) pieces.push([pos, ln.str.length]);
            pieces.forEach(([a, b]) => {
              const t = ln.str.slice(a, b);
              const box = t.trim() && rangeBox(ln, a, b);
              if (box) layer.push({ text: t, x: box.x, w: box.w, base: ln.base, size: ln.size });
            });
          });
          await addTextLayer(out, outPage, vp1.height, layer);
        } catch (e) { console.warn('[upmypdf] text layer skipped:', e && e.message); }
      }
      const bytes = await out.save({ useObjectStreams: true });
      const n = active().length, pg = Object.keys(byPage).length;
      showResult('findredact', bytes, `${baseName(f.name)}_redacted.pdf`, 'application/pdf', `${n} match${n > 1 ? 'es' : ''} redacted on ${pg} page${pg > 1 ? 's' : ''} · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('findredact', `❌ ${err.message || err}`, 'error');
    } finally {
      updateReady();
    }
  });
}
