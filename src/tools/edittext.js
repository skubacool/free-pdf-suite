// Edit PDF Text — click an existing line of text on the page, retype it, and
// download. Nothing leaves the browser.
//
// How it works: a PDF stores text as positioned glyphs, so each edited page is
// rendered to an image, the old words are erased by rebuilding the background from
// the pixels around them (the same blend Smart Erase uses), and the new words are
// written back as REAL PDF text using the typeface embedded in your own PDF, so
// they look and select exactly like the original. Characters the embedded copy of
// the font lacks use the closest matching font (or the font file you add).
// Pages you did not touch are copied across untouched; edited pages keep an
// invisible text layer for the lines you left alone.
import { blendFill } from './erase.js';
import { extractLines, addTextLayer } from './textlayer.js';
import { parseFontName } from './fontmatch.js';
import { loadEmbeddedFonts } from './embeddedfont.js';
import { makeContext, planLine, emitLine } from './textwriter.js';

// ---- user-supplied font files, remembered in this browser (never uploaded)
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('upmypdf-fonts', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('fonts');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idbGetAll = async () => {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const out = new Map();
      const tx = db.transaction('fonts').objectStore('fonts').openCursor();
      tx.onsuccess = () => { const c = tx.result; if (c) { out.set(c.key, c.value); c.continue(); } else res(out); };
      tx.onerror = () => res(out);
    });
  } catch (_) { return new Map(); }
};
const idbPut = async (k, v) => { try { const db = await idb(); db.transaction('fonts', 'readwrite').objectStore('fonts').put(v, k); } catch (_) {} };
const fontKey = (family, weight, italic) => `${family.toLowerCase().replace(/[^a-z0-9฀-๿]/g, '')}|${weight}|${italic ? 'i' : 'n'}`;
const keyOfName = (raw, weightOverride) => { const p = parseFontName(raw); return fontKey(p.family, weightOverride || p.weight, p.italic); };
// Company fonts hosted on the site itself (fonts/manifest.json lists the files). When a PDF uses a
// family listed there, its full font is loaded automatically for every visitor on every device.
const appBase = () => { const a = document.querySelector('script[src*="app.js"]'); return a ? new URL('.', a.src).href : '/'; };
const NUMERIC = /^[\s\d,.\-+%()฿$]+(บาท|THB|Baht)?\s*$/i;

export function initEditText() {
  const { $, $$, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, renderPreview, PDFLib } = window.appHelpers;
  const { PDFDocument } = PDFLib;
  if (!$('#dz-edittext')) return;

  const st = { file: null, bytes: null, doc: null, pageNum: 1, segs: {}, edits: {}, sel: null, fonts: null, userFonts: new Map(), siteList: null, siteLoaded: new Set() };
  const wrap = () => $('#wrap-edittext');
  const countEdits = () => Object.values(st.edits).reduce((a, m) => a + Object.keys(m).length, 0);
  const updateReady = () => {
    $('#btn-edittext').disabled = !(st.file && countEdits() > 0);
    $('#et-count').textContent = countEdits() ? `${countEdits()} line${countEdits() > 1 ? 's' : ''} changed` : '';
  };

  const loadSiteFonts = async (rawNames) => {
    try {
      if (!st.siteList) { const r = await fetch(`${appBase()}fonts/manifest.json`); st.siteList = r.ok ? await r.json() : []; }
      for (const raw of new Set(rawNames)) {
        const fam = keyOfName(raw).split('|')[0];
        for (const file of st.siteList) {
          if (!fam || !file.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(fam) || st.siteLoaded.has(file)) continue;
          st.siteLoaded.add(file);
          try {
            const res = await fetch(`${appBase()}fonts/${encodeURIComponent(file)}`);
            if (!res.ok) continue;
            const bytes = new Uint8Array(await res.arrayBuffer());
            const fk = window.fontkit.create(bytes);
            const key = keyOfName(fk.postscriptName || fk.fullName || file.replace(/\.[^.]+$/, ''));
            if (!st.userFonts.has(key)) st.userFonts.set(key, bytes); // a font the user added themselves wins
          } catch (_) { /* skip an unreadable font */ }
        }
      }
    } catch (_) { /* no site fonts: nothing to do */ }
  };

  // ---- find the editable lines on a page (merge neighbouring pdf.js runs)
  const rawNameOf = (page, fontName) => { try { return (page.commonObjs.get(fontName) || {}).name || ''; } catch (_) { return ''; } };
  const loadSegs = async (num) => {
    if (st.segs[num]) return st.segs[num];
    const page = await st.doc.getPage(num);
    const { width: W, height: H, lines } = await extractLines(page, { split: true });
    const segs = lines.map((l, id) => {
      const rawName = rawNameOf(page, l.fontName);
      return {
        id, text: l.str.replace(/\s+$/, '').replace(/ํา/g, 'ำ'), x: l.x / W, w: l.w / W, base: l.base / H, size: l.size, pageW: W, pageH: H, line: l,
        rawName, emb: st.fonts ? st.fonts.byRawName(rawName) : null, bold: parseFontName(rawName).weight >= 600, family: 'orig',
      };
    });
    // alignment: keep a right-aligned number column right-aligned, a centred title centred
    const L = (s) => s.line.x, R = (s) => s.line.x + s.line.w;
    segs.forEach((s) => {
      const o = segs.filter((q) => q !== s && Math.abs(q.line.base - s.line.base) > 3);
      const rightStrict = o.some((q) => Math.abs(R(q) - R(s)) < 1.5 && Math.abs(L(q) - L(s)) >= 1.5);
      const leftStrict = o.some((q) => Math.abs(L(q) - L(s)) < 1.5 && Math.abs(R(q) - R(s)) >= 1.5);
      const midStrict = o.some((q) => Math.abs((L(q) + R(q)) / 2 - (L(s) + R(s)) / 2) < 1.5 && Math.abs(L(q) - L(s)) >= 1.5 && Math.abs(R(q) - R(s)) >= 1.5);
      const numeric = NUMERIC.test(s.text) && R(s) > W * 0.5;
      s.autoAlign = rightStrict && !leftStrict ? 'right' : leftStrict && !rightStrict ? 'left' : midStrict && !leftStrict && !rightStrict ? 'center' : numeric ? 'right' : 'left';
    });
    st.segs[num] = segs;
    await loadSiteFonts(segs.map((q) => q.rawName));
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
    $('#et-align').value = e ? e.align : 'auto';
    $('#et-color').value = e && e.color ? e.color : '#000000';
    $('#et-usecolor').checked = !!(e && e.color);
    $('#et-orig').textContent = `Original: “${s.text}”`;
    refreshMarks();
    drawSample();
    $('#et-text').focus();
  };
  const currentSeg = () => st.sel && (st.segs[st.sel.page] || []).find((s) => s.id === st.sel.id);
  const readForm = (s) => ({ text: $('#et-text').value, size: Math.max(2, +$('#et-size').value || s.size), bold: $('#et-bold').checked, family: $('#et-family').value, align: $('#et-align').value, color: $('#et-usecolor').checked ? $('#et-color').value : null });
  const stage = () => {
    const s = currentSeg();
    if (!s) return;
    const m = (st.edits[st.sel.page] = st.edits[st.sel.page] || {});
    const f = readForm(s);
    if (f.text === s.text && !m[s.id]) return; // nothing changed yet
    m[s.id] = f;
    refreshMarks();
    updateReady();
  };

  // ---- build the plan for one edit (fonts, widths); shared by preview and download
  const hexColor = (c) => { const n = parseInt(c.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  const lineOpts = (s, e, color, pageH) => {
    const align = e.align === 'auto' ? s.autoAlign : e.align;
    const x0 = s.line.x, x1 = s.line.x + s.line.w;
    // a font file the user added: same family, and the weight the line asks for
    const wantW = e.bold === s.bold ? parseFontName(s.rawName).weight : (e.bold ? 700 : 400);
    const userBytes = st.userFonts.get(keyOfName(s.rawName, wantW)) || null;
    return {
      text: e.text, size: e.size, base: s.line.base, x0, x1, align, color, emb: s.emb, rawName: s.rawName, userKey: keyOfName(s.rawName, wantW),
      userBytes, family: e.family, bold: e.bold, forceSub: e.bold !== s.bold && !userBytes, pageH,
    };
  };

  // a live preview rendered through the same writer, so what you see is what you get
  let sampleTimer = null, sampleSeq = 0;
  const drawSample = () => {
    clearTimeout(sampleTimer);
    sampleTimer = setTimeout(async () => {
      const s = currentSeg(), cv = $('#et-sample');
      if (!s || !cv) return;
      const seq = ++sampleSeq;
      try {
        const e = readForm(s);
        const mini = await PDFDocument.create();
        const wctx = makeContext(mini);
        const H = Math.max(26, e.size * 1.9);
        const color = e.color ? hexColor(e.color) : [0.07, 0.09, 0.15];
        const opts = { ...lineOpts(s, { ...e, align: 'left' }, color, H), x0: 8, x1: 8, base: e.size * 1.35 };
        const plan = await planLine(wctx, opts);
        const W = Math.max(220, plan.width + 24);
        const page = mini.addPage([W, H]);
        emitLine(wctx, page, plan);
        const bytes = await mini.save();
        const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
        const pg = await pdf.getPage(1);
        const vp = pg.getViewport({ scale: 3.6 });
        cv.width = vp.width; cv.height = vp.height;
        cv.style.height = `${Math.round(H * 1.8)}px`; cv.style.width = `${Math.round(W * 1.8)}px`; cv.style.maxWidth = '100%';
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        await pg.render({ canvasContext: g, viewport: vp }).promise;
        if (seq !== sampleSeq) return;
        const miss = plan.missing;
        if (plan.dropped.length) $('#et-fontinfo').textContent = '';
        $('#et-fontinfo').textContent = `Font: ${plan.usedFont || 'closest match'}` + (miss.length ? ` · not in your PDF's copy of this font: ${miss.slice(0, 12).join(' ')}. A close match is used for those; add the font file below for an exact match.` : plan.usedFont === 'your font file' || !plan.emb || e.bold !== s.bold ? '' : ' · exact glyphs from your PDF');
        $('#et-fontrow').classList.toggle('hidden', !(miss.length || !s.emb));
      } catch (err) { if (window.console) console.warn('[upmypdf] preview:', err && err.message); }
    }, 220);
  };
  ['et-text', 'et-size', 'et-bold', 'et-family', 'et-align', 'et-color', 'et-usecolor'].forEach((id) => {
    $(`#${id}`).addEventListener('input', () => { stage(); drawSample(); });
    $(`#${id}`).addEventListener('change', () => { stage(); drawSample(); });
  });
  $('#et-revert').addEventListener('click', () => {
    if (!st.sel) return;
    delete (st.edits[st.sel.page] || {})[st.sel.id];
    const s = currentSeg();
    if (s) select(s);
    updateReady();
  });
  // the user adds full font files (select the whole family at once); each is filed
  // under its own family + weight, so regular, bold and light lines each find theirs
  $('#et-fontfile').addEventListener('change', async () => {
    const files = [...$('#et-fontfile').files];
    let added = 0;
    for (const f of files) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const fk = window.fontkit.create(bytes); // throws if it is not a usable font
        const ps = fk.postscriptName || fk.fullName || f.name.replace(/\.[^.]+$/, '');
        const key = keyOfName(ps);
        st.userFonts.set(key, bytes);
        idbPut(key, bytes);
        added++;
      } catch (_) { /* skip files that are not fonts */ }
    }
    $('#et-fontfile').value = '';
    if (added) { setStatus('edittext', `✅ ${added} font file${added > 1 ? 's' : ''} added (kept in this browser only).`, 'success'); drawSample(); }
    else setStatus('edittext', '❌ Those files are not usable .ttf or .otf fonts.', 'error');
  });

  const style = document.createElement('style');
  style.textContent = '.et-seg{cursor:text;border-radius:3px;transition:background .12s}.et-seg:hover{background:rgba(37,99,235,.14);outline:1px solid rgba(37,99,235,.55)}.et-seg.edited{background:rgba(16,185,129,.22);outline:1px solid #10b981}.et-seg.sel{outline:2px solid #2563eb;background:rgba(37,99,235,.18)}';
  document.head.appendChild(style);

  setupDropzone('edittext', async ([f]) => {
    try {
      st.file = f; st.segs = {}; st.edits = {}; st.sel = null; hideResult('edittext');
      $('#et-editor').classList.add('hidden');
      setStatus('edittext', 'Loading preview…');
      st.bytes = await f.arrayBuffer();
      st.doc = await loadPdfJs(st.bytes.slice(0));
      try { st.fonts = await loadEmbeddedFonts(new Uint8Array(st.bytes.slice(0))); } catch (_) { st.fonts = null; }
      st.userFonts = await idbGetAll();
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

  // ---- apply: rasterize edited pages, erase the old words, write the new as real text
  // The text colour is the pixel furthest from the box's background colour
  // (median of the box), which also works for light text on a dark band.
  const sampleColor = (ctx, x, y, w, h) => {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.max(1, Math.min(cw - x, Math.ceil(w))); h = Math.max(1, Math.min(ch - y, Math.ceil(h)));
    const d = ctx.getImageData(x, y, w, h).data;
    const med = [0, 1, 2].map((k) => { const a = []; for (let i = k; i < d.length; i += 4) a.push(d[i]); a.sort((p, q) => p - q); return a[a.length >> 1]; });
    let best = -1, bi = 0;
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.abs(d[i] - med[0]) + Math.abs(d[i + 1] - med[1]) + Math.abs(d[i + 2] - med[2]);
      if (dist > best) { best = dist; bi = i; }
    }
    return [d[bi] / 255, d[bi + 1] / 255, d[bi + 2] / 255];
  };

  $('#btn-edittext').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    const btn = $('#btn-edittext');
    btn.disabled = true;
    hideResult('edittext');
    try {
      setStatus('edittext', 'Applying your edits…');
      const srcPdf = st.doc; // same document the lines were read from (its font names match)
      const srcDoc = await PDFDocument.load(st.bytes.slice(0));
      const out = await PDFDocument.create();
      const wctx = makeContext(out);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const notes = new Set(), drops = new Set();
      for (let i = 1; i <= srcPdf.numPages; i++) {
        const edits = st.edits[i] && Object.keys(st.edits[i]).length ? st.edits[i] : null;
        if (!edits) {
          const [p] = await out.copyPages(srcDoc, [i - 1]);
          out.addPage(p);
          continue;
        }
        const page = await srcPdf.getPage(i);
        await loadSegs(i);
        const vp1 = page.getViewport({ scale: 1 });
        // keep the page image under ~14 megapixels so phones and tablets do not run out of memory
        const SCALE = Math.max(1.5, Math.min(3, Math.sqrt(14e6 / (vp1.width * vp1.height))));
        const vp = page.getViewport({ scale: SCALE });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const segs = st.segs[i] || [];
        // measure every colour first, then erase, then write (a later erase must not smear an earlier sample)
        const jobs = [];
        for (const s of segs.filter((q) => edits[q.id])) {
          const e = edits[s.id];
          const px = s.size * SCALE;
          const left = (s.x * canvas.width) - px * 0.04;
          const wpx = s.w * canvas.width + px * 0.08;
          const top = s.base * canvas.height - px * 1.0;
          const hpx = px * 1.35;
          const color = e.color ? hexColor(e.color) : sampleColor(ctx, left, top, wpx, hpx);
          jobs.push({ s, e, left, wpx, top, hpx, color });
        }
        jobs.forEach((j) => blendFill(ctx, canvas.width, canvas.height, j.left, j.top, j.wpx, j.hpx, 'auto'));

        // PNG keeps flat documents (quotes, invoices) razor sharp and small; photos fall back to JPEG
        const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const img = png && png.size < 1600000 ? await out.embedPng(await png.arrayBuffer()) : await out.embedJpg(await window.appHelpers.canvasToJpeg(canvas, 0.93));
        const outPage = out.addPage([vp1.width, vp1.height]);
        outPage.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });

        for (const j of jobs) {
          const plan = await planLine(wctx, lineOpts(j.s, j.e, j.color, vp1.height));
          emitLine(wctx, outPage, plan);
          if (plan.missing.length) notes.add(plan.missing.join(''));
          plan.dropped.forEach((d) => drops.add(d));
        }
        // lines that were not edited keep their real text, invisibly, so the page stays searchable
        const layer = segs.filter((s) => !edits[s.id]).map((s) => ({ text: s.line.str, x: s.line.x, w: s.line.w, base: s.line.base, size: s.line.size }));
        try { await addTextLayer(out, outPage, vp1.height, layer); } catch (e) { console.warn('[upmypdf] text layer skipped:', e && e.message); }
      }
      const bytes = await out.save({ useObjectStreams: true });
      const n = countEdits();
      showResult('edittext', bytes, `${baseName(f.name)}_edited.pdf`, 'application/pdf', `${n} line${n > 1 ? 's' : ''} changed · ${fmtBytes(bytes.length)}${notes.size ? ` · some characters (${[...notes].join('').slice(0, 20)}) are not in the PDF's copy of the font, so a close match was used` : ''}${drops.size ? ` · ⚠️ could not load a matching font (${[...drops].join(' ').slice(0, 40)}) — check your internet connection and try again` : ''}`);
    } catch (err) {
      setStatus('edittext', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = !(st.file && countEdits() > 0);
    }
  });
}
