/* Free PDF Suite — 100% client-side PDF utilities.
 * Libraries: pdf-lib (write/assemble), pdfjs-dist (read/render/decrypt), mammoth (docx -> html).
 * No file data ever leaves the browser. */
'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

  const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // pdf-lib standard fonts use WinAnsi encoding; map common typographic chars
  // and drop anything outside Latin-1 so drawText never throws mid-conversion.
  const toWinAnsi = (s) =>
    s
      .replace(/[‘’‚]/g, "'")
      .replace(/[“”„]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      .replace(/[ \t]/g, ' ')
      .replace(/[^\x20-\xFF]/g, '');

  // Unicode (Thai) text support: pdf-lib standard fonts cannot encode Thai, so
  // when text contains Thai characters we embed Noto Sans Thai via fontkit.
  // The font is fetched once and cached for the session; subsetting keeps the
  // saved PDF small.
  const UNICODE_FONT_URL = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-thai/NotoSansThai_400Regular.ttf';
  let unicodeFontBytes = null;
  const hasThai = (s) => /[฀-๿]/.test(s);
  const getUnicodeFont = async (doc) => {
    if (typeof fontkit === 'undefined') throw new Error('Font engine still loading — please try again in a moment.');
    doc.registerFontkit(fontkit);
    if (!unicodeFontBytes) {
      const res = await fetch(UNICODE_FONT_URL);
      if (!res.ok) throw new Error('Could not download the Thai font — check your connection and try again.');
      unicodeFontBytes = await res.arrayBuffer();
    }
    return doc.embedFont(unicodeFontBytes, { subset: true });
  };

  const setStatus = (tool, msg, kind = 'info') => {
    const el = $(`#status-${tool}`);
    if (!el) return;
    el.textContent = msg;
    el.className = 'mt-4 text-sm font-medium ' +
      (kind === 'error' ? 'text-red-700' : kind === 'success' ? 'text-emerald-700' : 'text-slate-500');
  };

  const results = {}; // tool -> { blob, filename }
  const showResult = (tool, bytesOrBlob, filename, mime, infoText) => {
    const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob], { type: mime });
    results[tool] = { blob, filename };
    $(`#res-${tool}`).classList.remove('hidden');
    $(`#info-${tool}`).textContent = infoText || `${filename} · ${fmtBytes(blob.size)}`;
    setStatus(tool, '✅ Done! Your file is ready below.', 'success');
    // Inline preview-before-download: render the produced PDF so users can
    // verify it before downloading. Gated on a viewable PDF + a preview slot.
    if (blob.type === 'application/pdf' && $(`#preview-result-${tool}`)) mountResultPreview(tool, blob);
    afterResult(tool);
  };

  // Fired on every successful result: log an analytics event, remember the tool
  // for the "Recently used" row, and add a "Process another file" reset button.
  function afterResult(tool) {
    try { if (window.gtag) gtag('event', 'tool_completed', { tool_name: tool, page_path: location.pathname }); } catch (_) {}
    try {
      const h2 = document.querySelector(`#panel-${tool} h2`);
      const name = (h2 && h2.textContent.trim()) || tool;
      const url = location.pathname;
      if (url && url !== '/' && !/\/index\.html$/.test(url)) {
        const KEY = 'upmypdf_recent';
        let list = [];
        try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) {}
        list = list.filter((r) => r && r.url !== url);
        list.unshift({ name, url });
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, 6)));
      }
    } catch (_) {}
    const res = document.getElementById(`res-${tool}`);
    if (res && !res.querySelector('.do-another')) {
      const dl = res.querySelector('[id^="dl-"]');
      if (dl) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'do-another btn border border-slate-300 rounded-xl px-5 py-3 font-semibold hover:bg-slate-100';
        b.textContent = '↻ Process another file';
        b.addEventListener('click', () => { hideResult(tool); const dz = document.getElementById(`dz-${tool}`); if (dz) dz.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
        dl.insertAdjacentElement('afterend', b);
      }
    }
  }
  $$('[id^="dl-"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.id.slice(3);
      const r = results[tool];
      if (!r) return;
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
  });

  const hideResult = (tool) => {
    $(`#res-${tool}`)?.classList.add('hidden');
    const pv = $(`#preview-result-${tool}`);
    if (pv) { pv.classList.add('hidden'); pv.innerHTML = ''; }
    delete results[tool];
  };

  // Render a produced PDF inline (with page navigation) so the user can confirm
  // it looks right before downloading. Best-effort: any failure (e.g. the file
  // is itself password-protected, as Protect output is) just hides the preview
  // and never blocks the download. Declared as a hoisted function so showResult
  // can call it regardless of source order.
  async function mountResultPreview(tool, blob) {
    const host = $(`#preview-result-${tool}`);
    if (!host) return;
    try {
      const buf = await blob.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      const total = doc.numPages;
      let cur = 1;
      host.classList.remove('hidden');
      host.innerHTML =
        `<div class="text-xs font-semibold text-slate-500 mb-2">👁️ Preview — check this looks right before downloading</div>
         <div class="relative inline-block border border-slate-200 rounded-xl overflow-hidden bg-white">
           <canvas class="preview-canvas" style="cursor:default"></canvas>
         </div>
         <div class="mt-2 flex items-center gap-3 text-sm">
           <button type="button" data-prev class="btn border border-slate-300 rounded-lg px-3 py-1 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed">‹ Prev</button>
           <span data-label class="text-slate-500"></span>
           <button type="button" data-next class="btn border border-slate-300 rounded-lg px-3 py-1 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed">Next ›</button>
         </div>`;
      const canvas = host.querySelector('canvas');
      const label = host.querySelector('[data-label]');
      const prev = host.querySelector('[data-prev]');
      const next = host.querySelector('[data-next]');
      const draw = async () => {
        const page = await doc.getPage(cur);
        const containerW = Math.min(460, host.clientWidth || 460);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = (containerW / vp1.width) * (window.devicePixelRatio > 1 ? 1.5 : 1);
        const vp = page.getViewport({ scale });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        canvas.style.width = `${containerW}px`;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        label.textContent = `Page ${cur} of ${total}`;
        prev.disabled = cur <= 1;
        next.disabled = cur >= total;
      };
      prev.addEventListener('click', () => { if (cur > 1) { cur--; draw(); } });
      next.addEventListener('click', () => { if (cur < total) { cur++; draw(); } });
      await draw();
    } catch (_) {
      host.classList.add('hidden');
      host.innerHTML = '';
    }
  }

  const baseName = (name) => name.replace(/\.[^.]+$/, '');

  const setupDropzone = (tool, onFiles) => {
    const dz = $(`#dz-${tool}`);
    const input = $(`#file-${tool}`);
    dz.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files.length) onFiles([...input.files]);
      input.value = '';
    });
    ['dragover', 'dragenter'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', (e) => {
      const files = [...e.dataTransfer.files];
      if (files.length) onFiles(files);
    });
  };

  const canvasToJpeg = (canvas, quality) =>
    new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('Canvas export failed'))),
        'image/jpeg',
        quality
      );
    });

  const loadPdfJs = (data, password) =>
    pdfjsLib.getDocument({ data: data.slice(0), password }).promise;

  // ---------------------------------------------------- encrypted-PDF support
  // pdf-lib (1.17.1) cannot decrypt content streams, so an encrypted source —
  // even one with NO open password (owner-only / permissions encryption) —
  // makes PDFDocument.load throw "is encrypted". pdf.js *can* open such files
  // (it auto-tries an empty user password), so when pdf-lib balks we re-open
  // with pdf.js and rasterize each page into a fresh, unencrypted document the
  // editing tools can work on. We only surface an error when a real open
  // password is actually required — matching the rule "no password ⇒ no error".
  const PW_NEEDED_MSG = 'This PDF needs a password to open — unlock it first.';
  const rasterizeToDoc = async (src, scale = 2, quality = 0.85) => {
    const out = await PDFDocument.create();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale });
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const jpg = await out.embedJpg(await canvasToJpeg(canvas, quality));
      out.addPage([vp1.width, vp1.height]).drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }
    return out;
  };
  // Load a PDF for pdf-lib editing, transparently decrypting no-password
  // encryption. Throws PW_NEEDED_MSG only when a real open password is required.
  const loadPdfForEdit = async (buf) => {
    try {
      return await PDFDocument.load(buf.slice(0));
    } catch (err) {
      if (!/encrypt/i.test(String(err))) throw err;
      let src;
      try {
        src = await loadPdfJs(buf);
      } catch (e) {
        if (e?.name === 'PasswordException') throw new Error(PW_NEEDED_MSG);
        throw e;
      }
      return rasterizeToDoc(src);
    }
  };
  // Page count only — avoids rasterizing just to probe an encrypted file.
  const readPageCount = async (buf) => {
    try {
      return (await PDFDocument.load(buf.slice(0))).getPageCount();
    } catch (err) {
      if (!/encrypt/i.test(String(err))) throw err;
      try {
        return (await loadPdfJs(buf)).numPages;
      } catch (e) {
        if (e?.name === 'PasswordException') throw new Error(PW_NEEDED_MSG);
        throw e;
      }
    }
  };

  // Lazily inject a third-party UMD script once, resolving when its global is
  // available. Used for the heavier, less-common converters (PptxGenJS, SheetJS)
  // so the core tools stay lightweight.
  const scriptPromises = {};
  const loadScriptOnce = (src, globalName) => {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => (window[globalName] ? resolve(window[globalName])
          : reject(new Error('Converter library failed to initialize.')));
        s.onerror = () => { delete scriptPromises[src]; reject(new Error('Could not load a required library — check your connection and try again.')); };
        document.head.appendChild(s);
      });
    }
    return scriptPromises[src];
  };

  // ----------------------------------------------------------- view routing
  // Two page types share this script:
  //  - The homepage hub ("/") has #home-view (card grid) + #tool-view and swaps
  //    panels in place, mirroring the active tool in the URL hash.
  //  - Dedicated static landing pages (/merge-pdf/, /sign-pdf/, ...) declare
  //    <body data-default-tool="..."> and ship without #home-view. They never
  //    write to the URL, so each route remains a clean, individually indexable
  //    document with its own immutable <head> metadata.
  const TOOLS = ['merge', 'split', 'rotate', 'compress', 'unlock', 'protect', 'sign', 'seal', 'type', 'pagenum', 'watermark', 'word2pdf', 'pdf2word', 'img2pdf', 'pdf2jpg', 'pdf2png', 'grayscale', 'redact', 'extractimg', 'addpage', 'pdf2ppt', 'pdf2excel', 'excel2pdf', 'delete', 'organize', 'crop', 'nup', 'ocr', 'targetsize', 'pdf2text', 'pdf2md', 'pdf2html', 'text2pdf', 'wordcount', 'metaview', 'metaedit', 'metaremove', 'flatten', 'unannotate', 'reverse', 'duplicate', 'interleave', 'zippdf', 'resize', 'invert', 'flip', 'scanned', 'longpage', 'split-horiz', 'addcover', 'removeblank', 'pdf2webp', 'svg2pdf', 'md2pdf', 'bgcolor', 'dimensions', 'links', 'compare', 'booklet', 'formfiller', 'png2pdf', 'webp2pdf', 'bmp2pdf', 'gif2pdf', 'tiff2pdf', 'divide', 'addimage', 'embedfile', 'extractfiles', 'xml2pdf', 'inspect', 'html2pdf'];
  const DEDICATED_TOOL = document.body.dataset.defaultTool || '';
  const activate = (view, scroll = true) => {
    const isTool = TOOLS.includes(view);
    $('#home-view')?.classList.toggle('hidden', isTool);
    $('#tool-view')?.classList.toggle('hidden', !isTool);
    if (isTool) {
      $$('.panel').forEach((p) => p.classList.add('hidden'));
      $(`#panel-${view}`)?.classList.remove('hidden');
    }
    if (!DEDICATED_TOOL) {
      history.replaceState(null, '', isTool ? `#${view}` : location.pathname + location.search);
    }
    if (scroll) window.scrollTo(0, 0);
  };
  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => activate(b.dataset.tool)));
  $$('[data-home]').forEach((b) => b.addEventListener('click', () => activate('home')));

  // Close the language dropdown when clicking outside it.
  document.addEventListener('click', (e) => {
    $$('details.lang-switch[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
  activate(location.hash.replace('#', '') || DEDICATED_TOOL || 'home', false);
  // Use-case pages may declare a preset (e.g. <body data-preset='{"mb":2}'>) to
  // pre-fill a tool's options on load.
  try {
    const preset = document.body.dataset.preset && JSON.parse(document.body.dataset.preset);
    if (preset && preset.mb != null && $('#mb-targetsize')) $('#mb-targetsize').value = preset.mb;
  } catch (_) {}
  if ($('#year')) $('#year').textContent = new Date().getFullYear();

  // ================================================================= MERGE
  const mergeState = { files: [] };
  const renderMergeList = () => {
    const ul = $('#files-merge');
    ul.innerHTML = '';
    mergeState.files.forEach((f, i) => {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm';
      li.innerHTML = `<span class="font-medium truncate">${escapeHtml(f.name)}</span>
        <span class="text-slate-400 whitespace-nowrap">${fmtBytes(f.size)}</span>
        <span class="ml-auto flex gap-1">
          <button data-act="up" data-i="${i}" class="border border-slate-300 rounded-lg px-2.5 py-0.5 hover:bg-white" title="Move up">↑</button>
          <button data-act="down" data-i="${i}" class="border border-slate-300 rounded-lg px-2.5 py-0.5 hover:bg-white" title="Move down">↓</button>
          <button data-act="rm" data-i="${i}" class="border border-red-200 text-red-700 rounded-lg px-2.5 py-0.5 hover:bg-red-50" title="Remove">✕</button>
        </span>`;
      ul.appendChild(li);
    });
    $('#btn-merge').disabled = mergeState.files.length < 2;
  };
  $('#files-merge').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = +btn.dataset.i;
    const act = btn.dataset.act;
    if (act === 'rm') mergeState.files.splice(i, 1);
    if (act === 'up' && i > 0) [mergeState.files[i - 1], mergeState.files[i]] = [mergeState.files[i], mergeState.files[i - 1]];
    if (act === 'down' && i < mergeState.files.length - 1)
      [mergeState.files[i + 1], mergeState.files[i]] = [mergeState.files[i], mergeState.files[i + 1]];
    renderMergeList();
  });
  setupDropzone('merge', (files) => {
    mergeState.files.push(...files.filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf'));
    hideResult('merge');
    setStatus('merge', '');
    renderMergeList();
  });
  $('#btn-merge').addEventListener('click', async () => {
    const btn = $('#btn-merge');
    btn.disabled = true;
    hideResult('merge');
    try {
      const out = await PDFDocument.create();
      for (let i = 0; i < mergeState.files.length; i++) {
        const f = mergeState.files[i];
        setStatus('merge', `Merging ${i + 1} of ${mergeState.files.length}: ${f.name}…`);
        let src;
        try {
          src = await loadPdfForEdit(await f.arrayBuffer());
        } catch (err) {
          const locked = /password/i.test(String(err)) || /encrypt/i.test(String(err));
          throw new Error(`"${f.name}" could not be read${locked ? ' — it needs a password to open. Unlock it first.' : '.'}`);
        }
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      }
      const bytes = await out.save({ useObjectStreams: true });
      showResult('merge', bytes, 'merged.pdf', 'application/pdf',
        `merged.pdf · ${out.getPageCount()} pages · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('merge', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = mergeState.files.length < 2;
    }
  });

  // ============================================================== COMPRESS
  const compressState = { file: null };
  setupDropzone('compress', ([f]) => {
    compressState.file = f;
    $('#picked-compress').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-compress').disabled = false;
    hideResult('compress');
    setStatus('compress', '');
  });
  const COMPRESS_PRESETS = {
    extreme: { scale: 1.0, quality: 0.45 },
    balanced: { scale: 1.5, quality: 0.62 },
    light: { scale: 2.0, quality: 0.8 },
  };
  $('#btn-compress').addEventListener('click', async () => {
    const f = compressState.file;
    if (!f) return;
    const btn = $('#btn-compress');
    btn.disabled = true;
    hideResult('compress');
    const { scale, quality } = COMPRESS_PRESETS[$('#quality-compress').value];
    try {
      const data = await f.arrayBuffer();
      const src = await loadPdfJs(data);
      const out = await PDFDocument.create();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      for (let i = 1; i <= src.numPages; i++) {
        setStatus('compress', `Compressing page ${i} of ${src.numPages}…`);
        const page = await src.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const jpg = await out.embedJpg(await canvasToJpeg(canvas, quality));
        const p = out.addPage([vp1.width, vp1.height]);
        p.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      }
      const bytes = await out.save({ useObjectStreams: true });
      const saved = Math.max(0, Math.round((1 - bytes.length / f.size) * 100));
      showResult('compress', bytes, `${baseName(f.name)}_compressed.pdf`, 'application/pdf',
        `${fmtBytes(f.size)} → ${fmtBytes(bytes.length)} (${saved}% smaller)`);
    } catch (err) {
      setStatus('compress',
        `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ================================================================ UNLOCK
  const unlockState = { file: null };
  setupDropzone('unlock', ([f]) => {
    unlockState.file = f;
    $('#picked-unlock').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-unlock').disabled = false;
    hideResult('unlock');
    setStatus('unlock', '');
  });
  $('#btn-unlock').addEventListener('click', async () => {
    const f = unlockState.file;
    if (!f) return;
    const btn = $('#btn-unlock');
    btn.disabled = true;
    hideResult('unlock');
    try {
      const data = await f.arrayBuffer();
      const password = $('#pw-unlock').value || undefined;
      let src;
      try {
        src = await loadPdfJs(data, password);
      } catch (err) {
        if (err?.name === 'PasswordException') {
          throw new Error(password
            ? 'Incorrect password. Please check it and try again.'
            : 'This PDF requires a password — enter it above and try again.');
        }
        throw err;
      }
      setStatus('unlock', 'Password accepted — rebuilding unlocked copy…');
      const out = await PDFDocument.create();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      for (let i = 1; i <= src.numPages; i++) {
        setStatus('unlock', `Rebuilding page ${i} of ${src.numPages}…`);
        const page = await src.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 2 });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.85));
        const p = out.addPage([vp1.width, vp1.height]);
        p.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      }
      const bytes = await out.save({ useObjectStreams: true });
      showResult('unlock', bytes, `${baseName(f.name)}_unlocked.pdf`, 'application/pdf');
    } catch (err) {
      setStatus('unlock', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ----------------------------------------------- shared preview renderer
  // Renders a page into a preview canvas and returns nothing; placement is
  // stored as coordinates normalized to the canvas (0..1) so it maps to PDF
  // points regardless of preview scale.
  async function renderPreview(state, canvasId, wrapId) {
    const canvas = $(canvasId);
    const page = await state.doc.getPage(state.pageNum);
    const containerW = Math.min(560, $(wrapId).parentElement.clientWidth || 560);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = (containerW / vp1.width) * (window.devicePixelRatio > 1 ? 1.5 : 1);
    const vp = page.getViewport({ scale });
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    canvas.style.width = `${containerW}px`;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    $$(`.place-marker`, $(wrapId)).forEach((m) => m.remove());
  }

  const clickToNorm = (e, canvas) => {
    const rect = canvas.getBoundingClientRect();
    return {
      nx: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      ny: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  // ================================================================== SIGN
  const signState = { file: null, doc: null, pageNum: 1, placement: null, hasInk: false, mode: 'draw', typedName: '', uploadedDataUrl: null };

  // signature pad
  const pad = $('#sigpad');
  const padCtx = pad.getContext('2d');
  padCtx.lineWidth = 2.5;
  padCtx.lineCap = 'round';
  padCtx.lineJoin = 'round';
  padCtx.strokeStyle = '#1e293b';
  let drawing = false;
  const padPos = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
  };
  pad.addEventListener('pointerdown', (e) => {
    drawing = true;
    signState.hasInk = true;
    pad.setPointerCapture(e.pointerId);
    const { x, y } = padPos(e);
    padCtx.beginPath();
    padCtx.moveTo(x, y);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const { x, y } = padPos(e);
    padCtx.lineTo(x, y);
    padCtx.stroke();
  });
  ['pointerup', 'pointercancel'].forEach((ev) => pad.addEventListener(ev, () => (drawing = false)));
  $('#sig-clear').addEventListener('click', () => {
    if (signState.mode === 'draw') {
      padCtx.clearRect(0, 0, pad.width, pad.height);
      signState.hasInk = false;
    } else if (signState.mode === 'type') {
      signState.typedName = '';
      $('#sig-type-text').value = '';
    } else {
      signState.uploadedDataUrl = null;
      $('#sig-upload-input').value = '';
      $('#sig-upload-preview').innerHTML = '';
    }
    updateSignReady();
  });
  $('#sig-width').addEventListener('input', () => {
    $('#sig-width-val').textContent = `${$('#sig-width').value}%`;
  });

  // Signature source modes: draw on the pad, type a name in a script face, or
  // upload an existing signature image. All three resolve to a PNG data URL.
  const setSigMode = (mode) => {
    signState.mode = mode;
    $('#sigpad').classList.toggle('hidden', mode !== 'draw');
    $('#sig-type-box').classList.toggle('hidden', mode !== 'type');
    $('#sig-upload-box').classList.toggle('hidden', mode !== 'upload');
    $$('.sigmode').forEach((b) => {
      const on = b.dataset.sigmode === mode;
      b.className = 'sigmode btn text-sm rounded-lg px-3.5 py-1.5 ' + (on
        ? 'border border-brand-600 bg-brand-50 text-brand-700 font-semibold'
        : 'border border-slate-300 hover:bg-slate-100');
    });
    updateSignReady();
  };
  $$('.sigmode').forEach((b) => b.addEventListener('click', () => setSigMode(b.dataset.sigmode)));
  $('#sig-type-text').addEventListener('input', () => {
    signState.typedName = $('#sig-type-text').value.trim();
    updateSignReady();
  });
  $('#sig-upload-input').addEventListener('change', () => {
    const f = $('#sig-upload-input').files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      signState.uploadedDataUrl = reader.result;
      $('#sig-upload-preview').innerHTML = `<img src="${reader.result}" alt="Signature preview" class="max-h-20 inline-block" />`;
      updateSignReady();
    };
    reader.readAsDataURL(f);
  });
  const hasSignature = () =>
    signState.mode === 'draw' ? signState.hasInk
    : signState.mode === 'type' ? !!signState.typedName
    : !!signState.uploadedDataUrl;
  const signaturePngDataUrl = () =>
    new Promise((resolve, reject) => {
      if (signState.mode === 'draw') return resolve(pad.toDataURL('image/png'));
      if (signState.mode === 'type') {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        const fontSpec = '72px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
        ctx.font = fontSpec;
        c.width = Math.ceil(ctx.measureText(signState.typedName).width) + 48;
        c.height = 130;
        ctx.font = fontSpec; // resizing the canvas resets context state
        ctx.fillStyle = '#1e293b';
        ctx.textBaseline = 'middle';
        ctx.fillText(signState.typedName, 24, 65);
        return resolve(c.toDataURL('image/png'));
      }
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Could not read the uploaded signature image.'));
      img.src = signState.uploadedDataUrl;
    });

  const updateSignReady = () => {
    $('#btn-sign').disabled = !(signState.file && hasSignature() && signState.placement);
  };

  setupDropzone('sign', async ([f]) => {
    try {
      signState.file = f;
      signState.placement = null;
      hideResult('sign');
      setStatus('sign', 'Loading preview…');
      signState.doc = await loadPdfJs(await f.arrayBuffer());
      signState.pageNum = 1;
      $('#page-sign').value = 1;
      $('#page-sign').max = signState.doc.numPages;
      $('#pages-sign').textContent = `/ ${signState.doc.numPages}`;
      $('#picked-sign').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#work-sign').classList.remove('hidden');
      await renderPreview(signState, '#preview-sign', '#wrap-sign');
      setStatus('sign', 'Draw your signature, then click on the page where it should appear.');
    } catch (err) {
      setStatus('sign',
        `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    }
    updateSignReady();
  });
  $('#page-sign').addEventListener('change', async () => {
    if (!signState.doc) return;
    signState.pageNum = Math.min(Math.max(1, +$('#page-sign').value || 1), signState.doc.numPages);
    $('#page-sign').value = signState.pageNum;
    signState.placement = null;
    await renderPreview(signState, '#preview-sign', '#wrap-sign');
    updateSignReady();
  });
  $('#preview-sign').addEventListener('click', (e) => {
    if (!signState.doc) return;
    signState.placement = clickToNorm(e, $('#preview-sign'));
    $$('.place-marker', $('#wrap-sign')).forEach((m) => m.remove());
    const marker = document.createElement('div');
    marker.className = 'place-marker text-2xl';
    marker.textContent = '✍️';
    marker.style.left = `${signState.placement.nx * 100}%`;
    marker.style.top = `${signState.placement.ny * 100}%`;
    $('#wrap-sign').appendChild(marker);
    updateSignReady();
  });
  $('#btn-sign').addEventListener('click', async () => {
    const btn = $('#btn-sign');
    btn.disabled = true;
    hideResult('sign');
    try {
      setStatus('sign', 'Embedding signature…');
      const doc = await loadPdfForEdit(await signState.file.arrayBuffer());
      const page = doc.getPage(signState.pageNum - 1);
      const { width: pw, height: ph } = page.getSize();
      const pngBytes = await (await fetch(await signaturePngDataUrl())).arrayBuffer();
      const img = await doc.embedPng(pngBytes);
      const w = (pw * +$('#sig-width').value) / 100;
      const h = (w * img.height) / img.width;
      page.drawImage(img, {
        x: signState.placement.nx * pw - w / 2,
        y: ph - signState.placement.ny * ph - h / 2,
        width: w,
        height: h,
      });
      const bytes = await doc.save();
      showResult('sign', bytes, `${baseName(signState.file.name)}_signed.pdf`, 'application/pdf');
    } catch (err) {
      setStatus('sign', `❌ ${err.message || err}`, 'error');
    } finally {
      updateSignReady();
    }
  });

  // =========================================================== TYPE ON PDF
  const typeState = { file: null, doc: null, pageNum: 1, items: [] };
  const hexToRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    const n = m ? parseInt(m[1], 16) : 0;
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };
  const renderTypeItems = () => {
    const ul = $('#items-type');
    ul.innerHTML = '';
    typeState.items.forEach((it, i) => {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-1.5';
      li.innerHTML = `<span class="truncate">“${escapeHtml(it.text)}” — page ${it.page}, ${it.size}pt</span>
        <button data-i="${i}" class="ml-auto border border-red-200 text-red-700 rounded-lg px-2.5 py-0.5 hover:bg-red-50">✕</button>`;
      ul.appendChild(li);
    });
    $('#btn-type').disabled = typeState.items.length === 0;
    redrawTypeMarkers();
  };
  const redrawTypeMarkers = () => {
    const wrap = $('#wrap-type');
    $$('.place-marker', wrap).forEach((m) => m.remove());
    const canvas = $('#preview-type');
    typeState.items.filter((it) => it.page === typeState.pageNum).forEach((it) => {
      const m = document.createElement('div');
      m.className = 'place-marker font-semibold whitespace-nowrap';
      m.style.left = `${it.nx * 100}%`;
      m.style.top = `${it.ny * 100}%`;
      m.style.color = it.colorHex;
      m.style.fontSize = `${Math.max(8, it.size * (canvas.clientWidth / (it.pageW || 595)))}px`;
      m.textContent = it.text;
      wrap.appendChild(m);
    });
  };
  $('#items-type').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    typeState.items.splice(+btn.dataset.i, 1);
    renderTypeItems();
  });
  setupDropzone('type', async ([f]) => {
    try {
      typeState.file = f;
      typeState.items = [];
      hideResult('type');
      setStatus('type', 'Loading preview…');
      typeState.doc = await loadPdfJs(await f.arrayBuffer());
      typeState.pageNum = 1;
      $('#page-type').value = 1;
      $('#page-type').max = typeState.doc.numPages;
      $('#pages-type').textContent = `/ ${typeState.doc.numPages} pages`;
      $('#picked-type').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#work-type').classList.remove('hidden');
      await renderPreview(typeState, '#preview-type', '#wrap-type');
      renderTypeItems();
      setStatus('type', 'Type your text above, then click on the page to place it. Repeat as needed.');
    } catch (err) {
      setStatus('type',
        `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    }
  });
  $('#page-type').addEventListener('change', async () => {
    if (!typeState.doc) return;
    typeState.pageNum = Math.min(Math.max(1, +$('#page-type').value || 1), typeState.doc.numPages);
    $('#page-type').value = typeState.pageNum;
    await renderPreview(typeState, '#preview-type', '#wrap-type');
    redrawTypeMarkers();
  });
  $('#preview-type').addEventListener('click', async (e) => {
    if (!typeState.doc) return;
    const text = $('#text-input').value.trim();
    if (!text) {
      setStatus('type', 'Type some text in the box first, then click the page.', 'error');
      return;
    }
    const { nx, ny } = clickToNorm(e, $('#preview-type'));
    const page = await typeState.doc.getPage(typeState.pageNum);
    typeState.items.push({
      text,
      nx,
      ny,
      page: typeState.pageNum,
      size: Math.min(72, Math.max(6, +$('#text-size').value || 14)),
      colorHex: $('#text-color').value,
      pageW: page.getViewport({ scale: 1 }).width,
    });
    setStatus('type', '');
    renderTypeItems();
  });
  $('#btn-type').addEventListener('click', async () => {
    const btn = $('#btn-type');
    btn.disabled = true;
    hideResult('type');
    try {
      setStatus('type', 'Writing text into PDF…');
      const doc = await loadPdfForEdit(await typeState.file.arrayBuffer());
      const needsUnicode = typeState.items.some((it) => hasThai(it.text));
      const font = needsUnicode ? await getUnicodeFont(doc) : await doc.embedFont(StandardFonts.Helvetica);
      for (const it of typeState.items) {
        const page = doc.getPage(it.page - 1);
        const { width: pw, height: ph } = page.getSize();
        page.drawText((needsUnicode ? it.text : toWinAnsi(it.text)) || ' ', {
          x: it.nx * pw,
          y: ph - it.ny * ph - it.size * 0.78,
          size: it.size,
          font,
          color: hexToRgb(it.colorHex),
        });
      }
      const bytes = await doc.save();
      showResult('type', bytes, `${baseName(typeState.file.name)}_edited.pdf`, 'application/pdf');
    } catch (err) {
      setStatus('type', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = typeState.items.length === 0;
    }
  });

  // ============================================================ WORD -> PDF
  const w2pState = { file: null };
  setupDropzone('word2pdf', ([f]) => {
    if (!/\.docx$/i.test(f.name)) {
      setStatus('word2pdf', '❌ Please choose a .docx file (legacy .doc is not supported).', 'error');
      return;
    }
    w2pState.file = f;
    $('#picked-word2pdf').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-word2pdf').disabled = false;
    hideResult('word2pdf');
    setStatus('word2pdf', '');
  });

  const wrapText = (text, font, size, maxWidth) => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(probe, size) <= maxWidth) {
        line = probe;
      } else {
        if (line) lines.push(line);
        // hard-break words longer than the line
        let w = word;
        while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
          let cut = w.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut--;
          lines.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };

  $('#btn-word2pdf').addEventListener('click', async () => {
    const f = w2pState.file;
    if (!f) return;
    const btn = $('#btn-word2pdf');
    btn.disabled = true;
    hideResult('word2pdf');
    try {
      setStatus('word2pdf', 'Reading document…');
      const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() });
      const dom = new DOMParser().parseFromString(html, 'text/html');

      const blocks = [];
      const walk = (node, inList) => {
        for (const el of node.children) {
          const tag = el.tagName.toLowerCase();
          if (tag === 'ul' || tag === 'ol') {
            walk(el, true);
          } else if (tag === 'li') {
            blocks.push({ text: `• ${el.textContent.trim()}`, size: 11.5, bold: false, indent: 16 });
            walk(el, true);
          } else if (/^h[1-6]$/.test(tag)) {
            const level = +tag[1];
            blocks.push({ text: el.textContent.trim(), size: [22, 17, 14.5, 13, 12, 11.5][level - 1], bold: true, indent: 0 });
          } else if (tag === 'table') {
            for (const tr of el.querySelectorAll('tr')) {
              const cells = [...tr.children].map((td) => td.textContent.trim()).filter(Boolean);
              if (cells.length) blocks.push({ text: cells.join('  |  '), size: 10.5, bold: false, indent: 8 });
            }
          } else if (tag === 'p' || tag === 'div' || tag === 'blockquote') {
            const t = el.textContent.trim();
            if (t) blocks.push({ text: t, size: 11.5, bold: false, indent: inList ? 16 : 0 });
            else blocks.push({ text: '', size: 11.5, bold: false, indent: 0 });
          }
        }
      };
      walk(dom.body, false);
      if (!blocks.some((b) => b.text)) throw new Error('No readable text found in this document.');

      setStatus('word2pdf', 'Laying out PDF…');
      const doc = await PDFDocument.create();
      const needsUnicode = blocks.some((b) => hasThai(b.text));
      const fontReg = needsUnicode ? await getUnicodeFont(doc) : await doc.embedFont(StandardFonts.Helvetica);
      const fontBold = needsUnicode ? fontReg : await doc.embedFont(StandardFonts.HelveticaBold);
      const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 56; // A4
      let page = doc.addPage([PAGE_W, PAGE_H]);
      let y = PAGE_H - MARGIN;
      for (const b of blocks) {
        const font = b.bold ? fontBold : fontReg;
        const text = needsUnicode ? b.text : toWinAnsi(b.text);
        const maxW = PAGE_W - MARGIN * 2 - b.indent;
        const lineH = b.size * 1.45;
        if (!text) { y -= lineH * 0.7; continue; }
        for (const line of wrapText(text, font, b.size, maxW)) {
          if (y < MARGIN + b.size) {
            page = doc.addPage([PAGE_W, PAGE_H]);
            y = PAGE_H - MARGIN;
          }
          page.drawText(line, { x: MARGIN + b.indent, y: y - b.size, size: b.size, font, color: rgb(0.07, 0.09, 0.15) });
          y -= lineH;
        }
        y -= b.size * 0.35; // paragraph spacing
      }
      const bytes = await doc.save({ useObjectStreams: true });
      showResult('word2pdf', bytes, `${baseName(f.name)}.pdf`, 'application/pdf',
        `${baseName(f.name)}.pdf · ${doc.getPageCount()} pages · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('word2pdf', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ============================================================ PDF -> WORD
  const p2wState = { file: null };
  setupDropzone('pdf2word', ([f]) => {
    p2wState.file = f;
    $('#picked-pdf2word').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-pdf2word').disabled = false;
    hideResult('pdf2word');
    setStatus('pdf2word', '');
  });
  $('#btn-pdf2word').addEventListener('click', async () => {
    const f = p2wState.file;
    if (!f) return;
    const btn = $('#btn-pdf2word');
    btn.disabled = true;
    hideResult('pdf2word');
    try {
      const src = await loadPdfJs(await f.arrayBuffer());
      const pagesHtml = [];
      for (let i = 1; i <= src.numPages; i++) {
        setStatus('pdf2word', `Extracting text from page ${i} of ${src.numPages}…`);
        const content = await (await src.getPage(i)).getTextContent();
        const lines = [];
        let line = '';
        for (const item of content.items) {
          line += item.str;
          if (item.hasEOL) {
            lines.push(line);
            line = '';
          } else if (item.str && !item.str.endsWith(' ')) {
            line += ' ';
          }
        }
        if (line.trim()) lines.push(line);
        pagesHtml.push(lines.map((l) => `<p>${escapeHtml(l.trim()) || '&nbsp;'}</p>`).join('\n'));
      }
      const docHtml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${escapeHtml(baseName(f.name))}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}p{margin:0 0 6pt 0}</style></head>
<body>${pagesHtml.join(`\n<br clear="all" style="mso-special-character:line-break;page-break-before:always" />\n`)}</body></html>`;
      const blob = new Blob(['﻿', docHtml], { type: 'application/msword' });
      showResult('pdf2word', blob, `${baseName(f.name)}.doc`, 'application/msword',
        `${baseName(f.name)}.doc · ${src.numPages} pages extracted · ${fmtBytes(blob.size)}`);
    } catch (err) {
      setStatus('pdf2word',
        `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ================================================================= SPLIT
  const splitState = { file: null, pageCount: 0 };
  // "1-3, 5, 8" -> sorted unique page numbers, or null if invalid/out of range
  const parseRanges = (str, max) => {
    const picked = new Set();
    if (!str.trim()) return null;
    for (const part of str.split(',')) {
      const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
      if (!m) return null;
      let a = +m[1];
      let b = m[2] ? +m[2] : a;
      if (a > b) [a, b] = [b, a];
      if (a < 1 || b > max) return null;
      for (let i = a; i <= b; i++) picked.add(i);
    }
    return [...picked].sort((x, y) => x - y);
  };
  setupDropzone('split', async ([f]) => {
    hideResult('split');
    try {
      setStatus('split', 'Reading PDF…');
      splitState.pageCount = await readPageCount(await f.arrayBuffer());
      splitState.file = f;
      $('#picked-split').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${splitState.pageCount} pages`;
      $('#btn-split').disabled = false;
      setStatus('split', '');
    } catch (err) {
      splitState.file = null;
      $('#btn-split').disabled = true;
      setStatus('split',
        `❌ ${/encrypt/i.test(String(err)) ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    }
  });
  $('#btn-split').addEventListener('click', async () => {
    const f = splitState.file;
    if (!f) return;
    const btn = $('#btn-split');
    btn.disabled = true;
    hideResult('split');
    try {
      const picked = parseRanges($('#range-split').value, splitState.pageCount);
      if (!picked) throw new Error(`Enter a valid page range between 1 and ${splitState.pageCount}, e.g. 1-3, 5.`);
      const mode = $('input[name="mode-split"]:checked').value;
      const keep = mode === 'extract'
        ? picked
        : Array.from({ length: splitState.pageCount }, (_, i) => i + 1).filter((p) => !picked.includes(p));
      if (!keep.length) throw new Error('Nothing left to save — removing those pages would empty the document.');
      setStatus('split', `Building PDF with ${keep.length} page${keep.length > 1 ? 's' : ''}…`);
      const src = await loadPdfForEdit(await f.arrayBuffer());
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, keep.map((p) => p - 1));
      pages.forEach((p) => out.addPage(p));
      const bytes = await out.save({ useObjectStreams: true });
      showResult('split', bytes, `${baseName(f.name)}_${mode === 'extract' ? 'extracted' : 'trimmed'}.pdf`, 'application/pdf',
        `${keep.length} of ${splitState.pageCount} pages kept · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('split', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = !splitState.file;
    }
  });

  // ================================================================ ROTATE
  const rotateState = { file: null, pageCount: 0 };
  setupDropzone('rotate', async ([f]) => {
    hideResult('rotate');
    try {
      setStatus('rotate', 'Reading PDF…');
      rotateState.pageCount = await readPageCount(await f.arrayBuffer());
      rotateState.file = f;
      $('#picked-rotate').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${rotateState.pageCount} pages`;
      $('#btn-rotate').disabled = false;
      setStatus('rotate', '');
    } catch (err) {
      rotateState.file = null;
      $('#btn-rotate').disabled = true;
      setStatus('rotate',
        `❌ ${/encrypt/i.test(String(err)) ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    }
  });
  $('#btn-rotate').addEventListener('click', async () => {
    const f = rotateState.file;
    if (!f) return;
    const btn = $('#btn-rotate');
    btn.disabled = true;
    hideResult('rotate');
    try {
      const rangeStr = $('#range-rotate').value;
      const targets = rangeStr.trim()
        ? parseRanges(rangeStr, rotateState.pageCount)
        : Array.from({ length: rotateState.pageCount }, (_, i) => i + 1);
      if (!targets) throw new Error(`Enter a valid page range between 1 and ${rotateState.pageCount}, or leave it empty for all pages.`);
      const delta = +$('#angle-rotate').value;
      setStatus('rotate', `Rotating ${targets.length} page${targets.length > 1 ? 's' : ''}…`);
      const doc = await loadPdfForEdit(await f.arrayBuffer());
      for (const p of targets) {
        const page = doc.getPage(p - 1);
        page.setRotation(degrees((page.getRotation().angle + delta) % 360));
      }
      const bytes = await doc.save();
      showResult('rotate', bytes, `${baseName(f.name)}_rotated.pdf`, 'application/pdf');
    } catch (err) {
      setStatus('rotate', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = !rotateState.file;
    }
  });

  // ============================================================ JPG TO PDF
  const i2pState = { files: [] };
  const renderI2pList = () => {
    const ul = $('#files-img2pdf');
    ul.innerHTML = '';
    i2pState.files.forEach((f, i) => {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm';
      li.innerHTML = `<span class="font-medium truncate">${escapeHtml(f.name)}</span>
        <span class="text-slate-400 whitespace-nowrap">${fmtBytes(f.size)}</span>
        <span class="ml-auto flex gap-1">
          <button data-act="up" data-i="${i}" class="border border-slate-300 rounded-lg px-2.5 py-0.5 hover:bg-white" title="Move up">↑</button>
          <button data-act="down" data-i="${i}" class="border border-slate-300 rounded-lg px-2.5 py-0.5 hover:bg-white" title="Move down">↓</button>
          <button data-act="rm" data-i="${i}" class="border border-red-200 text-red-700 rounded-lg px-2.5 py-0.5 hover:bg-red-50" title="Remove">✕</button>
        </span>`;
      ul.appendChild(li);
    });
    $('#btn-img2pdf').disabled = i2pState.files.length === 0;
  };
  $('#files-img2pdf').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = +btn.dataset.i;
    const act = btn.dataset.act;
    if (act === 'rm') i2pState.files.splice(i, 1);
    if (act === 'up' && i > 0) [i2pState.files[i - 1], i2pState.files[i]] = [i2pState.files[i], i2pState.files[i - 1]];
    if (act === 'down' && i < i2pState.files.length - 1)
      [i2pState.files[i + 1], i2pState.files[i]] = [i2pState.files[i], i2pState.files[i + 1]];
    renderI2pList();
  });
  setupDropzone('img2pdf', (files) => {
    const imgs = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name) || ['image/jpeg', 'image/png'].includes(f.type));
    if (!imgs.length) {
      setStatus('img2pdf', '❌ Please choose JPG or PNG images.', 'error');
      return;
    }
    i2pState.files.push(...imgs);
    hideResult('img2pdf');
    setStatus('img2pdf', '');
    renderI2pList();
  });
  $('#btn-img2pdf').addEventListener('click', async () => {
    const btn = $('#btn-img2pdf');
    btn.disabled = true;
    hideResult('img2pdf');
    try {
      const mode = $('#size-img2pdf').value;
      const A4 = [595.28, 841.89];
      const MARGIN = 36;
      const out = await PDFDocument.create();
      for (let i = 0; i < i2pState.files.length; i++) {
        const f = i2pState.files[i];
        setStatus('img2pdf', `Adding image ${i + 1} of ${i2pState.files.length}: ${f.name}…`);
        const data = await f.arrayBuffer();
        const isPng = f.type === 'image/png' || /\.png$/i.test(f.name);
        let img;
        try {
          img = isPng ? await out.embedPng(data) : await out.embedJpg(data);
        } catch {
          throw new Error(`"${f.name}" could not be read — please use standard JPG or PNG images.`);
        }
        if (mode === 'fit') {
          const page = out.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        } else {
          const page = out.addPage(A4);
          const scale = Math.min((A4[0] - MARGIN * 2) / img.width, (A4[1] - MARGIN * 2) / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
        }
      }
      const bytes = await out.save({ useObjectStreams: true });
      showResult('img2pdf', bytes, 'images.pdf', 'application/pdf',
        `images.pdf · ${i2pState.files.length} page${i2pState.files.length > 1 ? 's' : ''} · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('img2pdf', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = i2pState.files.length === 0;
    }
  });

  // ============================================================ PDF TO JPG
  const p2jState = { file: null };
  setupDropzone('pdf2jpg', ([f]) => {
    p2jState.file = f;
    $('#picked-pdf2jpg').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-pdf2jpg').disabled = false;
    hideResult('pdf2jpg');
    setStatus('pdf2jpg', '');
  });
  $('#btn-pdf2jpg').addEventListener('click', async () => {
    const f = p2jState.file;
    if (!f) return;
    const btn = $('#btn-pdf2jpg');
    btn.disabled = true;
    hideResult('pdf2jpg');
    try {
      const hi = $('#quality-pdf2jpg').value === 'high';
      const scale = hi ? 2 : 1.5;
      const quality = hi ? 0.92 : 0.8;
      const src = await loadPdfJs(await f.arrayBuffer());
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const images = [];
      for (let i = 1; i <= src.numPages; i++) {
        setStatus('pdf2jpg', `Rendering page ${i} of ${src.numPages}…`);
        const page = await src.getPage(i);
        const vp = page.getViewport({ scale });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        images.push(await canvasToJpeg(canvas, quality));
      }
      if (images.length === 1) {
        showResult('pdf2jpg', new Blob([images[0]], { type: 'image/jpeg' }), `${baseName(f.name)}.jpg`, 'image/jpeg');
      } else {
        setStatus('pdf2jpg', 'Packing images into a ZIP…');
        const zip = new JSZip();
        const pad = String(images.length).length;
        images.forEach((img, i) =>
          zip.file(`${baseName(f.name)}_page_${String(i + 1).padStart(pad, '0')}.jpg`, img));
        const blob = await zip.generateAsync({ type: 'blob' });
        showResult('pdf2jpg', blob, `${baseName(f.name)}_images.zip`, 'application/zip',
          `${images.length} images · ${fmtBytes(blob.size)}`);
      }
    } catch (err) {
      setStatus('pdf2jpg',
        `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    } finally {
      btn.disabled = !p2jState.file;
    }
  });

  // ======================================================== PAGE NUMBERS
  const pnState = { file: null };
  setupDropzone('pagenum', ([f]) => {
    pnState.file = f;
    $('#picked-pagenum').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-pagenum').disabled = false;
    hideResult('pagenum');
    setStatus('pagenum', '');
  });
  $('#btn-pagenum').addEventListener('click', async () => {
    const f = pnState.file;
    if (!f) return;
    const btn = $('#btn-pagenum');
    btn.disabled = true;
    hideResult('pagenum');
    try {
      setStatus('pagenum', 'Adding page numbers…');
      const doc = await loadPdfForEdit(await f.arrayBuffer());
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const total = doc.getPageCount();
      const fmt = $('#fmt-pagenum').value;
      const pos = $('#pos-pagenum').value;
      const SIZE = 10;
      const MARGIN = 28;
      for (let i = 0; i < total; i++) {
        const page = doc.getPage(i);
        const { width: pw, height: ph } = page.getSize();
        const label = fmt === 'pageofn' ? `Page ${i + 1} of ${total}` : String(i + 1);
        const tw = font.widthOfTextAtSize(label, SIZE);
        const x = pos.endsWith('left') ? MARGIN : pos.endsWith('right') ? pw - MARGIN - tw : (pw - tw) / 2;
        const y = pos.startsWith('top') ? ph - MARGIN : 18;
        page.drawText(label, { x, y, size: SIZE, font, color: rgb(0.3, 0.3, 0.3) });
      }
      const bytes = await doc.save();
      showResult('pagenum', bytes, `${baseName(f.name)}_numbered.pdf`, 'application/pdf',
        `${total} pages numbered · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('pagenum',
        `❌ ${/encrypt/i.test(String(err)) ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    } finally {
      btn.disabled = !pnState.file;
    }
  });

  // ============================================================ WATERMARK
  const wmState = { file: null };
  $('#opacity-watermark').addEventListener('input', () => {
    $('#opacity-val').textContent = `${$('#opacity-watermark').value}%`;
  });
  setupDropzone('watermark', ([f]) => {
    wmState.file = f;
    $('#picked-watermark').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-watermark').disabled = false;
    hideResult('watermark');
    setStatus('watermark', '');
  });
  $('#btn-watermark').addEventListener('click', async () => {
    const f = wmState.file;
    if (!f) return;
    const raw = $('#text-watermark').value.trim();
    if (!raw) {
      setStatus('watermark', 'Type the watermark text first — e.g. CONFIDENTIAL or DRAFT.', 'error');
      return;
    }
    const btn = $('#btn-watermark');
    btn.disabled = true;
    hideResult('watermark');
    try {
      setStatus('watermark', 'Stamping watermark…');
      const doc = await loadPdfForEdit(await f.arrayBuffer());
      const thai = hasThai(raw);
      const font = thai ? await getUnicodeFont(doc) : await doc.embedFont(StandardFonts.HelveticaBold);
      const text = thai ? raw : toWinAnsi(raw);
      const opacity = +$('#opacity-watermark').value / 100;
      const pos = ($('#pos-watermark') && $('#pos-watermark').value) || 'diagonal';
      const color = rgb(0.55, 0.55, 0.55);
      const cos45 = Math.cos(Math.PI / 4);
      for (const page of doc.getPages()) {
        const { width: pw, height: ph } = page.getSize();
        // Auto-fit: scale a 60pt probe so the text spans a target width in points,
        // so the watermark always fits the page regardless of its dimensions.
        const w60 = font.widthOfTextAtSize(text, 60) || 1;
        const fit = (targetW, max) => Math.max(12, Math.min(max, (60 * targetW) / w60));
        if (pos === 'tile') {
          const size = fit(pw * 0.30, 46);
          const tw = font.widthOfTextAtSize(text, size);
          const stepX = tw + size * 2.2;
          const stepY = size * 3.2;
          for (let yy = -size; yy < ph + stepY; yy += stepY)
            for (let xx = -tw; xx < pw + tw; xx += stepX)
              page.drawText(text, { x: xx, y: yy, size, font, color, opacity, rotate: degrees(45) });
        } else if (pos === 'diagonal') {
          const diag = Math.sqrt(pw * pw + ph * ph);
          const size = fit(diag * 0.6, 110);
          const tw = font.widthOfTextAtSize(text, size);
          page.drawText(text, {
            x: pw / 2 - (tw / 2) * cos45,
            y: ph / 2 - (tw / 2) * cos45,
            size, font, color, opacity, rotate: degrees(45),
          });
        } else {
          // horizontal placements: center / top / bottom
          const size = fit(pw * 0.7, 84);
          const tw = font.widthOfTextAtSize(text, size);
          const x = (pw - tw) / 2;
          const y = pos === 'top' ? ph - 44 - size * 0.2
                  : pos === 'bottom' ? 40
                  : ph / 2 - size * 0.35;
          page.drawText(text, { x, y, size, font, color, opacity });
        }
      }
      const bytes = await doc.save();
      showResult('watermark', bytes, `${baseName(f.name)}_watermarked.pdf`, 'application/pdf');
    } catch (err) {
      setStatus('watermark',
        `❌ ${/encrypt/i.test(String(err)) ? 'This PDF is password-protected — unlock it first.' : err.message || err}`,
        'error');
    } finally {
      btn.disabled = !wmState.file;
    }
  });

  // ============================================================== PROTECT
  // pdf-lib cannot write encrypted PDFs, so this tool lazily loads the
  // @cantoo/pdf-lib fork (which adds AES encryption) only when used. The fork's
  // UMD bundle also sets window.PDFLib, so we swap the global back immediately.
  const protState = { file: null };
  let encryptLibPromise = null;
  const getEncryptLib = () => {
    if (!encryptLibPromise) {
      encryptLibPromise = new Promise((resolve, reject) => {
        const orig = window.PDFLib;
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@cantoo/pdf-lib/dist/pdf-lib.min.js';
        s.onload = () => {
          const lib = window.PDFLib;
          window.PDFLib = orig;
          lib && lib !== orig ? resolve(lib) : reject(new Error('Encryption library failed to initialize.'));
        };
        s.onerror = () => {
          window.PDFLib = orig;
          encryptLibPromise = null;
          reject(new Error('Could not load the encryption library — check your connection and try again.'));
        };
        document.head.appendChild(s);
      });
    }
    return encryptLibPromise;
  };
  setupDropzone('protect', ([f]) => {
    protState.file = f;
    $('#picked-protect').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-protect').disabled = false;
    hideResult('protect');
    setStatus('protect', '');
  });
  $('#btn-protect').addEventListener('click', async () => {
    const f = protState.file;
    if (!f) return;
    const pw = $('#pw-protect').value;
    if (pw.length < 4) {
      setStatus('protect', 'Choose a password of at least 4 characters.', 'error');
      return;
    }
    const btn = $('#btn-protect');
    btn.disabled = true;
    hideResult('protect');
    try {
      setStatus('protect', 'Loading encryption engine…');
      const lib = await getEncryptLib();
      setStatus('protect', 'Encrypting PDF…');
      const doc = await lib.PDFDocument.load(await f.arrayBuffer());
      let bytes;
      if (typeof doc.encrypt === 'function') {
        await doc.encrypt({ userPassword: pw, ownerPassword: pw });
        bytes = await doc.save();
      } else {
        bytes = await doc.save({ userPassword: pw, ownerPassword: pw });
      }
      showResult('protect', bytes, `${baseName(f.name)}_protected.pdf`, 'application/pdf');
    } catch (err) {
      setStatus('protect',
        `❌ ${/encrypt/i.test(String(err)) && /load/i.test(String(err)) ? 'This PDF is already password-protected.' : err.message || err}`,
        'error');
    } finally {
      btn.disabled = !protState.file;
    }
  });

  // ========================================================== DELETE PAGES
  // Self-guarded: only initializes on pages that contain its panel.
  if ($('#dz-delete')) {
    const delState = { file: null, pageCount: 0 };
    setupDropzone('delete', async ([f]) => {
      hideResult('delete');
      try {
        setStatus('delete', 'Reading PDF…');
        delState.pageCount = await readPageCount(await f.arrayBuffer());
        delState.file = f;
        $('#picked-delete').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${delState.pageCount} pages`;
        $('#btn-delete').disabled = false;
        setStatus('delete', '');
      } catch (err) {
        delState.file = null;
        $('#btn-delete').disabled = true;
        setStatus('delete', `❌ ${/encrypt/i.test(String(err)) ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
      }
    });
    $('#btn-delete').addEventListener('click', async () => {
      const f = delState.file;
      if (!f) return;
      const btn = $('#btn-delete');
      btn.disabled = true;
      hideResult('delete');
      try {
        const picked = parseRanges($('#range-delete').value, delState.pageCount);
        if (!picked) throw new Error(`Enter valid pages between 1 and ${delState.pageCount}, e.g. 2, 5-7.`);
        const keep = Array.from({ length: delState.pageCount }, (_, i) => i + 1).filter((p) => !picked.includes(p));
        if (!keep.length) throw new Error('That would delete every page — nothing would be left to save.');
        setStatus('delete', `Removing ${picked.length} page${picked.length > 1 ? 's' : ''}…`);
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        (await out.copyPages(src, keep.map((p) => p - 1))).forEach((p) => out.addPage(p));
        const bytes = await out.save({ useObjectStreams: true });
        showResult('delete', bytes, `${baseName(f.name)}_pages_removed.pdf`, 'application/pdf',
          `${picked.length} removed · ${keep.length} of ${delState.pageCount} pages kept · ${fmtBytes(bytes.length)}`);
      } catch (err) {
        setStatus('delete', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = !delState.file;
      }
    });
  }

  // ====================================================== ORGANIZE / REORDER
  if ($('#dz-organize')) {
    const orgState = { file: null };
    const wrap = $('#thumbs-organize');
    const updateOrgReady = () => {
      $('#btn-organize').disabled = !(orgState.file && wrap.querySelectorAll('.thumb').length > 0);
    };
    setupDropzone('organize', async ([f]) => {
      hideResult('organize');
      try {
        setStatus('organize', 'Rendering page thumbnails…');
        orgState.file = f;
        const src = await loadPdfJs(await f.arrayBuffer());
        wrap.innerHTML = '';
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('organize', `Rendering page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale: 0.4 });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width);
          c.height = Math.ceil(vp.height);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const div = document.createElement('div');
          div.className = 'thumb relative border border-slate-200 rounded-lg bg-white p-1 cursor-move';
          div.draggable = true;
          div.dataset.page = i - 1;
          c.className = 'w-full h-auto rounded pointer-events-none';
          div.appendChild(c);
          const tag = document.createElement('div');
          tag.className = 'absolute bottom-1 left-1 text-[10px] font-bold text-white bg-slate-900/70 rounded px-1.5 py-0.5 pointer-events-none';
          tag.textContent = i;
          div.appendChild(tag);
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-xs bg-white border border-red-200 text-red-600 rounded-full hover:bg-red-50';
          rm.textContent = '✕';
          rm.addEventListener('click', () => {
            if (wrap.querySelectorAll('.thumb').length > 1) { div.remove(); updateOrgReady(); }
            else setStatus('organize', 'At least one page must remain.', 'error');
          });
          div.appendChild(rm);
          wrap.appendChild(div);
        }
        $('#work-organize').classList.remove('hidden');
        $('#picked-organize').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${src.numPages} pages. Drag to reorder, ✕ to remove.`;
        setStatus('organize', '');
        updateOrgReady();
      } catch (err) {
        setStatus('organize', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
      }
    });
    // HTML5 drag-and-drop reordering
    let dragEl = null;
    wrap.addEventListener('dragstart', (e) => {
      const t = e.target.closest('.thumb');
      if (!t) return;
      dragEl = t;
      t.classList.add('opacity-40');
    });
    wrap.addEventListener('dragend', () => {
      if (dragEl) dragEl.classList.remove('opacity-40');
      dragEl = null;
    });
    wrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      const t = e.target.closest('.thumb');
      if (!t || t === dragEl) return;
      const r = t.getBoundingClientRect();
      const after = (e.clientY < r.top + r.height / 2) ? false : true;
      // primarily horizontal grid: decide by x when on same row
      const afterX = (e.clientX - r.left) > r.width / 2;
      wrap.insertBefore(dragEl, afterX ? t.nextSibling : t);
    });
    $('#btn-organize').addEventListener('click', async () => {
      const f = orgState.file;
      if (!f) return;
      const btn = $('#btn-organize');
      btn.disabled = true;
      hideResult('organize');
      try {
        const order = [...wrap.querySelectorAll('.thumb')].map((d) => +d.dataset.page);
        if (!order.length) throw new Error('No pages left to save.');
        setStatus('organize', 'Rebuilding PDF in the new order…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        (await out.copyPages(src, order)).forEach((p) => out.addPage(p));
        const bytes = await out.save({ useObjectStreams: true });
        showResult('organize', bytes, `${baseName(f.name)}_organized.pdf`, 'application/pdf',
          `${order.length} pages · ${fmtBytes(bytes.length)}`);
      } catch (err) {
        setStatus('organize', `❌ ${err.message || err}`, 'error');
      } finally {
        updateOrgReady();
      }
    });
  }

  // ============================================================== CROP PDF
  if ($('#dz-crop')) {
    const cropState = { file: null };
    setupDropzone('crop', ([f]) => {
      cropState.file = f;
      $('#picked-crop').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-crop').disabled = false;
      hideResult('crop');
      setStatus('crop', '');
    });
    $('#btn-crop').addEventListener('click', async () => {
      const f = cropState.file;
      if (!f) return;
      const btn = $('#btn-crop');
      btn.disabled = true;
      hideResult('crop');
      try {
        const clamp = (v) => Math.min(45, Math.max(0, +v || 0));
        const T = clamp($('#crop-top').value), R = clamp($('#crop-right').value),
          B = clamp($('#crop-bottom').value), L = clamp($('#crop-left').value);
        if (T + B >= 90 || L + R >= 90) throw new Error('Those margins remove too much of the page — reduce them.');
        if (!T && !R && !B && !L) throw new Error('Enter how much to trim from at least one edge (in %).');
        setStatus('crop', 'Cropping pages…');
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        for (const page of doc.getPages()) {
          const mb = page.getMediaBox();
          const nx = mb.x + (mb.width * L) / 100;
          const ny = mb.y + (mb.height * B) / 100;
          const nw = mb.width * (1 - (L + R) / 100);
          const nh = mb.height * (1 - (T + B) / 100);
          page.setCropBox(nx, ny, nw, nh);
        }
        const bytes = await doc.save();
        showResult('crop', bytes, `${baseName(f.name)}_cropped.pdf`, 'application/pdf');
      } catch (err) {
        setStatus('crop', `❌ ${/encrypt/i.test(String(err)) ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
      } finally {
        btn.disabled = !cropState.file;
      }
    });
  }

  // ===================================================== N-UP (PAGES/SHEET)
  if ($('#dz-nup')) {
    const nupState = { file: null };
    setupDropzone('nup', ([f]) => {
      nupState.file = f;
      $('#picked-nup').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-nup').disabled = false;
      hideResult('nup');
      setStatus('nup', '');
    });
    $('#btn-nup').addEventListener('click', async () => {
      const f = nupState.file;
      if (!f) return;
      const btn = $('#btn-nup');
      btn.disabled = true;
      hideResult('nup');
      try {
        const per = +$('#per-nup').value; // 2 or 4
        const A4P = [595.28, 841.89], A4L = [841.89, 595.28];
        const size = per === 2 ? A4L : A4P;
        const cols = 2, rows = per === 2 ? 1 : 2;
        const M = 18, GAP = 10;
        setStatus('nup', 'Arranging pages…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const n = src.getPageCount();
        const cellW = (size[0] - 2 * M - (cols - 1) * GAP) / cols;
        const cellH = (size[1] - 2 * M - (rows - 1) * GAP) / rows;
        for (let i = 0; i < n; i += per) {
          const sheet = out.addPage(size);
          for (let k = 0; k < per && i + k < n; k++) {
            const sp = src.getPage(i + k);
            let emb;
            try { emb = await out.embedPage(sp); } catch { continue; } // skip blank/contentless pages
            const sw = sp.getWidth(), sh = sp.getHeight();
            const scale = Math.min(cellW / sw, cellH / sh);
            const w = sw * scale, h = sh * scale;
            const col = k % cols, row = Math.floor(k / cols);
            const cx = M + col * (cellW + GAP) + (cellW - w) / 2;
            const cy = size[1] - M - row * (cellH + GAP) - cellH + (cellH - h) / 2;
            sheet.drawPage(emb, { x: cx, y: cy, width: w, height: h });
          }
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('nup', bytes, `${baseName(f.name)}_${per}up.pdf`, 'application/pdf',
          `${Math.ceil(n / per)} sheets · ${fmtBytes(bytes.length)}`);
      } catch (err) {
        setStatus('nup', `❌ ${/encrypt/i.test(String(err)) ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
      } finally {
        btn.disabled = !nupState.file;
      }
    });
  }

  // ================================================================== OCR
  // Extracts text from scanned PDFs with Tesseract.js, loaded on demand and run
  // through a dedicated Web Worker that is explicitly terminated after the job.
  if ($('#dz-ocr')) {
    const ocrState = { file: null };
    let tessPromise = null;
    let ocrWorker = null;
    const loadTesseract = () => {
      if (window.Tesseract) return Promise.resolve(window.Tesseract);
      if (!tessPromise) {
        tessPromise = new Promise((resolve, reject) => {
          const sc = document.createElement('script');
          sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
          sc.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR engine failed to initialize.')));
          sc.onerror = () => { tessPromise = null; reject(new Error('Could not load the OCR engine — check your connection and try again.')); };
          document.head.appendChild(sc);
        });
      }
      return tessPromise;
    };
    const killWorker = () => {
      if (ocrWorker) { try { ocrWorker.terminate(); } catch (_) {} ocrWorker = null; }
    };
    // Terminate the worker if the user navigates away mid-job (prevents leaks).
    window.addEventListener('pagehide', killWorker);

    setupDropzone('ocr', ([f]) => {
      ocrState.file = f;
      $('#picked-ocr').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-ocr').disabled = false;
      hideResult('ocr');
      setStatus('ocr', '');
    });
    if ($('#copy-ocr')) {
      $('#copy-ocr').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText($('#ocr-text').value);
          const b = $('#copy-ocr'); const old = b.textContent;
          b.textContent = '✓ Copied'; setTimeout(() => (b.textContent = old), 1500);
        } catch (_) {
          $('#ocr-text').select(); document.execCommand('copy');
        }
      });
    }
    $('#btn-ocr').addEventListener('click', async () => {
      const f = ocrState.file;
      if (!f) return;
      const btn = $('#btn-ocr');
      btn.disabled = true;
      hideResult('ocr');
      try {
        const lang = $('#lang-ocr').value;             // eng | tha | eng+tha
        const dpi = +($('#dpi-ocr') ? $('#dpi-ocr').value : 2) || 2;  // 2x or 3x
        setStatus('ocr', 'Initializing OCR worker (first run downloads language data, ~10–20 MB)…');
        const Tesseract = await loadTesseract();
        const src = await loadPdfJs(await f.arrayBuffer());
        const total = src.numPages;
        killWorker();
        // Dedicated worker with a logger mapping the lifecycle to readable progress.
        ocrWorker = await Tesseract.createWorker(lang, 1, {
          logger: (m) => {
            if (m.status === 'recognizing text') {
              setStatus('ocr', `Recognizing text ${Math.round((m.progress || 0) * 100)}% — page ${ocrState._page || 1} of ${total}…`);
            } else if (m.status) {
              setStatus('ocr', m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…');
            }
          },
        });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        let out = '';
        for (let i = 1; i <= total; i++) {
          ocrState._page = i;
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale: dpi });
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const { data } = await ocrWorker.recognize(canvas);
          out += `--- Page ${i} ---\n${(data.text || '').trim()}\n\n`;
        }
        if (!out.replace(/--- Page \d+ ---/g, '').trim()) {
          throw new Error('No readable text was found. If this is a photo-only scan, try the 3× accuracy setting or a clearer, higher-resolution file.');
        }
        if ($('#ocr-text')) $('#ocr-text').value = out.trim();
        const blob = new Blob([out], { type: 'text/plain;charset=utf-8' });
        showResult('ocr', blob, `${baseName(f.name)}_text.txt`, 'text/plain',
          `${total} page${total > 1 ? 's' : ''} read · ${fmtBytes(blob.size)} of text`);
      } catch (err) {
        setStatus('ocr', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
      } finally {
        killWorker();   // always release the worker — no lingering background memory
        btn.disabled = !ocrState.file;
      }
    });
  }

  // ===================================================== ADAPTIVE TARGET-SIZE
  // "Compress to under X MB": iterative rasterize → JPEG re-embed, capped passes.
  if ($('#dz-targetsize')) {
    const tsState = { file: null };
    setupDropzone('targetsize', ([f]) => {
      tsState.file = f;
      $('#picked-targetsize').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-targetsize').disabled = false;
      hideResult('targetsize');
      setStatus('targetsize', '');
    });
    // Up to 3 passes of decreasing scale/quality (spec: cap at 3 loops).
    const PASSES = [
      { scale: 2.0, quality: 0.72 },
      { scale: 1.5, quality: 0.58 },
      { scale: 1.1, quality: 0.42 },
    ];
    const rasterize = async (file, scale, quality) => {
      const src = await loadPdfJs(await file.arrayBuffer());
      const out = await PDFDocument.create();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      for (let i = 1; i <= src.numPages; i++) {
        const page = await src.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const jpg = await out.embedJpg(await canvasToJpeg(canvas, quality));
        const p = out.addPage([vp1.width, vp1.height]);
        p.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      }
      return out.save({ useObjectStreams: true });
    };
    $('#btn-targetsize').addEventListener('click', async () => {
      const f = tsState.file;
      if (!f) return;
      const btn = $('#btn-targetsize');
      btn.disabled = true;
      hideResult('targetsize');
      try {
        const targetMB = parseFloat($('#mb-targetsize').value);
        if (!(targetMB > 0)) throw new Error('Enter a target size in MB, e.g. 2.');
        const targetBytes = targetMB * 1024 * 1024;
        if (f.size <= targetBytes) {
          showResult('targetsize', f, f.name, 'application/pdf',
            `Already ${fmtBytes(f.size)} — under your ${targetMB} MB target. No compression needed.`);
          return;
        }
        let best = null;
        for (let i = 0; i < PASSES.length; i++) {
          setStatus('targetsize', `Compressing — pass ${i + 1} of ${PASSES.length}…`);
          const bytes = await rasterize(f, PASSES[i].scale, PASSES[i].quality);
          if (!best || bytes.length < best.length) best = bytes;
          if (bytes.length <= targetBytes) { best = bytes; break; }
        }
        const met = best.length <= targetBytes;
        showResult('targetsize', best, `${baseName(f.name)}_under_${targetMB}MB.pdf`, 'application/pdf',
          met
            ? `${fmtBytes(f.size)} → ${fmtBytes(best.length)} ✓ under your ${targetMB} MB target.`
            : `${fmtBytes(f.size)} → ${fmtBytes(best.length)} — smallest achievable in 3 passes (just over ${targetMB} MB).`);
        if (!met) setStatus('targetsize', `Couldn't reach ${targetMB} MB without heavier quality loss — here is the smallest version.`, 'info');
      } catch (err) {
        setStatus('targetsize',
          `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
      } finally {
        btn.disabled = !tsState.file;
      }
    });
  }

  // ========================================================== COMPANY SEAL
  // Stamp a corporate seal / stamp image onto a chosen page at a chosen spot.
  // Modeled on the Sign tool: render a page preview, click to place, size to fit.
  if ($('#dz-seal')) {
    const sealState = { file: null, doc: null, pageNum: 1, placement: null, dataUrl: null, natW: 1, natH: 1 };
    const updateSealReady = () => {
      $('#btn-seal').disabled = !(sealState.file && sealState.dataUrl && sealState.placement);
    };
    const redrawSealMarker = () => {
      const wrap = $('#wrap-seal');
      if (!wrap) return;
      $$('.place-marker', wrap).forEach((m) => m.remove());
      if (!sealState.placement || !sealState.dataUrl) return;
      const canvas = $('#preview-seal');
      const dispW = (+$('#seal-size').value / 100) * canvas.clientWidth;
      const dispH = dispW * (sealState.natH / sealState.natW);
      const m = document.createElement('img');
      m.src = sealState.dataUrl;
      m.className = 'place-marker';
      m.style.width = `${dispW}px`;
      m.style.height = `${dispH}px`;
      m.style.left = `${sealState.placement.nx * 100}%`;
      m.style.top = `${sealState.placement.ny * 100}%`;
      m.style.opacity = '0.92';
      wrap.appendChild(m);
    };
    $('#seal-size').addEventListener('input', () => {
      $('#seal-size-val').textContent = `${$('#seal-size').value}%`;
      redrawSealMarker();
    });
    $('#seal-img-input').addEventListener('change', () => {
      const f = $('#seal-img-input').files[0];
      if (!f) return;
      if (!/image\/(png|jpeg)/.test(f.type) && !/\.(png|jpe?g)$/i.test(f.name)) {
        setStatus('seal', '❌ Please choose a PNG or JPG seal image.', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        sealState.dataUrl = reader.result;
        const img = new Image();
        img.onload = () => { sealState.natW = img.naturalWidth || 1; sealState.natH = img.naturalHeight || 1; redrawSealMarker(); };
        img.src = reader.result;
        $('#seal-img-preview').innerHTML = `<img src="${reader.result}" alt="Seal preview" class="max-h-20 inline-block" />`;
        updateSealReady();
      };
      reader.readAsDataURL(f);
    });
    setupDropzone('seal', async ([f]) => {
      try {
        sealState.file = f;
        sealState.placement = null;
        hideResult('seal');
        setStatus('seal', 'Loading preview…');
        sealState.doc = await loadPdfJs(await f.arrayBuffer());
        sealState.pageNum = 1;
        $('#page-seal').value = 1;
        $('#page-seal').max = sealState.doc.numPages;
        $('#pages-seal').textContent = `/ ${sealState.doc.numPages}`;
        $('#picked-seal').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
        $('#work-seal').classList.remove('hidden');
        await renderPreview(sealState, '#preview-seal', '#wrap-seal');
        redrawSealMarker();
        setStatus('seal', 'Upload your seal image, then click on the page where it should go.');
      } catch (err) {
        setStatus('seal', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      }
      updateSealReady();
    });
    $('#page-seal').addEventListener('change', async () => {
      if (!sealState.doc) return;
      sealState.pageNum = Math.min(Math.max(1, +$('#page-seal').value || 1), sealState.doc.numPages);
      $('#page-seal').value = sealState.pageNum;
      sealState.placement = null;
      await renderPreview(sealState, '#preview-seal', '#wrap-seal');
      updateSealReady();
    });
    $('#preview-seal').addEventListener('click', (e) => {
      if (!sealState.doc) return;
      sealState.placement = clickToNorm(e, $('#preview-seal'));
      redrawSealMarker();
      updateSealReady();
    });
    $('#btn-seal').addEventListener('click', async () => {
      const btn = $('#btn-seal');
      btn.disabled = true;
      hideResult('seal');
      try {
        setStatus('seal', 'Stamping seal…');
        const doc = await loadPdfForEdit(await sealState.file.arrayBuffer());
        const pageIdx = Math.min(sealState.pageNum, doc.getPageCount()) - 1;
        const page = doc.getPage(pageIdx);
        const { width: pw, height: ph } = page.getSize();
        const bytes = await (await fetch(sealState.dataUrl)).arrayBuffer();
        const img = /^data:image\/png/i.test(sealState.dataUrl) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const w = (pw * +$('#seal-size').value) / 100;
        const h = (w * img.height) / img.width;
        page.drawImage(img, {
          x: sealState.placement.nx * pw - w / 2,
          y: ph - sealState.placement.ny * ph - h / 2,
          width: w,
          height: h,
        });
        const outBytes = await doc.save();
        showResult('seal', outBytes, `${baseName(sealState.file.name)}_sealed.pdf`, 'application/pdf');
      } catch (err) {
        setStatus('seal', `❌ ${err.message || err}`, 'error');
      } finally {
        updateSealReady();
      }
    });
  }

  // ============================================================ PDF TO PNG
  if ($('#dz-pdf2png')) {
    const p2pngState = { file: null };
    setupDropzone('pdf2png', ([f]) => {
      p2pngState.file = f;
      $('#picked-pdf2png').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-pdf2png').disabled = false;
      hideResult('pdf2png');
      setStatus('pdf2png', '');
    });
    const canvasToPng = (canvas) => new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? b.arrayBuffer().then(res, rej) : rej(new Error('Canvas export failed'))), 'image/png'));
    $('#btn-pdf2png').addEventListener('click', async () => {
      const f = p2pngState.file;
      if (!f) return;
      const btn = $('#btn-pdf2png');
      btn.disabled = true;
      hideResult('pdf2png');
      try {
        const hi = $('#quality-pdf2png') && $('#quality-pdf2png').value === 'high';
        const scale = hi ? 2.5 : 1.5;
        const src = await loadPdfJs(await f.arrayBuffer());
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const images = [];
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('pdf2png', `Rendering page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale });
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          images.push(await canvasToPng(canvas));
        }
        if (images.length === 1) {
          showResult('pdf2png', new Blob([images[0]], { type: 'image/png' }), `${baseName(f.name)}.png`, 'image/png');
        } else {
          setStatus('pdf2png', 'Packing images into a ZIP…');
          const zip = new JSZip();
          const pad = String(images.length).length;
          images.forEach((img, i) => zip.file(`${baseName(f.name)}_page_${String(i + 1).padStart(pad, '0')}.png`, img));
          const blob = await zip.generateAsync({ type: 'blob' });
          showResult('pdf2png', blob, `${baseName(f.name)}_images.zip`, 'application/zip', `${images.length} images · ${fmtBytes(blob.size)}`);
        }
      } catch (err) {
        setStatus('pdf2png', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      } finally {
        btn.disabled = !p2pngState.file;
      }
    });
  }

  // ============================================================ GRAYSCALE
  if ($('#dz-grayscale')) {
    const gsState = { file: null };
    setupDropzone('grayscale', ([f]) => {
      gsState.file = f;
      $('#picked-grayscale').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-grayscale').disabled = false;
      hideResult('grayscale');
      setStatus('grayscale', '');
    });
    $('#btn-grayscale').addEventListener('click', async () => {
      const f = gsState.file;
      if (!f) return;
      const btn = $('#btn-grayscale');
      btn.disabled = true;
      hideResult('grayscale');
      try {
        const src = await loadPdfJs(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('grayscale', `Converting page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 2 });
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = im.data;
          for (let p = 0; p < d.length; p += 4) {
            const g = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) | 0;
            d[p] = d[p + 1] = d[p + 2] = g;
          }
          ctx.putImageData(im, 0, 0);
          const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.82));
          out.addPage([vp1.width, vp1.height]).drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('grayscale', bytes, `${baseName(f.name)}_grayscale.pdf`, 'application/pdf',
          `${src.numPages} page${src.numPages > 1 ? 's' : ''} · ${fmtBytes(bytes.length)}`);
      } catch (err) {
        setStatus('grayscale', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      } finally {
        btn.disabled = !gsState.file;
      }
    });
  }

  // ============================================================== REDACT
  // True redaction: marked areas are painted solid black and the whole page is
  // flattened to an image, so nothing survives underneath the marks.
  if ($('#dz-redact')) {
    const redState = { file: null, doc: null, pageNum: 1, rects: {} };
    const redWrap = () => $('#wrap-redact');
    const countRects = () => Object.values(redState.rects).reduce((a, r) => a + r.length, 0);
    const updateRedactReady = () => {
      const n = countRects();
      $('#btn-redact').disabled = !(redState.file && n > 0);
      if ($('#redact-count')) $('#redact-count').textContent = n ? `${n} box${n > 1 ? 'es' : ''} marked` : '';
    };
    const drawRedactBoxes = () => {
      $$('.redact-box', redWrap()).forEach((m) => m.remove());
      (redState.rects[redState.pageNum] || []).forEach((r, idx) => {
        const d = document.createElement('div');
        d.className = 'redact-box';
        d.style.cssText = `position:absolute;left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;background:rgba(15,23,42,0.85);border:1px solid #000;cursor:pointer;`;
        d.title = 'Click to remove this box';
        d.addEventListener('click', (e) => { e.stopPropagation(); redState.rects[redState.pageNum].splice(idx, 1); drawRedactBoxes(); updateRedactReady(); });
        redWrap().appendChild(d);
      });
    };
    setupDropzone('redact', async ([f]) => {
      try {
        redState.file = f; redState.rects = {}; hideResult('redact');
        setStatus('redact', 'Loading preview…');
        redState.doc = await loadPdfJs(await f.arrayBuffer());
        redState.pageNum = 1;
        $('#page-redact').value = 1;
        $('#page-redact').max = redState.doc.numPages;
        $('#pages-redact').textContent = `/ ${redState.doc.numPages}`;
        $('#picked-redact').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
        $('#work-redact').classList.remove('hidden');
        await renderPreview(redState, '#preview-redact', '#wrap-redact');
        drawRedactBoxes();
        setStatus('redact', 'Drag across the page to mark areas to hide. Click a box to remove it.');
      } catch (err) {
        setStatus('redact', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      }
      updateRedactReady();
    });
    $('#page-redact').addEventListener('change', async () => {
      if (!redState.doc) return;
      redState.pageNum = Math.min(Math.max(1, +$('#page-redact').value || 1), redState.doc.numPages);
      $('#page-redact').value = redState.pageNum;
      await renderPreview(redState, '#preview-redact', '#wrap-redact');
      drawRedactBoxes();
    });
    let dragStart = null, ghost = null;
    const relPos = (e) => {
      const rect = $('#preview-redact').getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) };
    };
    $('#preview-redact').addEventListener('pointerdown', (e) => {
      if (!redState.doc) return;
      dragStart = relPos(e);
      $('#preview-redact').setPointerCapture(e.pointerId);
      ghost = document.createElement('div');
      ghost.className = 'redact-box';
      ghost.style.cssText = 'position:absolute;background:rgba(15,23,42,0.5);border:1px dashed #000;';
      redWrap().appendChild(ghost);
    });
    $('#preview-redact').addEventListener('pointermove', (e) => {
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
      if (w > 0.01 && h > 0.01) {
        (redState.rects[redState.pageNum] = redState.rects[redState.pageNum] || []).push({ x, y, w, h });
        drawRedactBoxes();
        updateRedactReady();
        setStatus('redact', '');
      }
    };
    $('#preview-redact').addEventListener('pointerup', finishDrag);
    $('#preview-redact').addEventListener('pointercancel', finishDrag);
    $('#btn-redact').addEventListener('click', async () => {
      const f = redState.file;
      if (!f) return;
      const btn = $('#btn-redact');
      btn.disabled = true;
      hideResult('redact');
      try {
        setStatus('redact', 'Applying redactions…');
        const src = await loadPdfJs(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        for (let i = 1; i <= src.numPages; i++) {
          const page = await src.getPage(i);
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 2 });
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          (redState.rects[i] || []).forEach((r) => {
            ctx.fillStyle = '#000000';
            ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
          });
          const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.85));
          out.addPage([vp1.width, vp1.height]).drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        }
        const bytes = await out.save({ useObjectStreams: true });
        const n = countRects();
        showResult('redact', bytes, `${baseName(f.name)}_redacted.pdf`, 'application/pdf',
          `${n} area${n > 1 ? 's' : ''} redacted · flattened · ${fmtBytes(bytes.length)}`);
      } catch (err) {
        setStatus('redact', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      } finally {
        updateRedactReady();
      }
    });
  }

  // ===================================================== EXTRACT IMAGES
  // Pulls embedded raster images out via pdf.js. Best-effort: RGB/RGBA/gray
  // bitmaps are recovered; exotic colorspaces and soft masks are skipped.
  if ($('#dz-extractimg')) {
    const exState = { file: null };
    setupDropzone('extractimg', ([f]) => {
      exState.file = f;
      $('#picked-extractimg').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-extractimg').disabled = false;
      hideResult('extractimg');
      setStatus('extractimg', '');
    });
    const imgObjToBuf = (img) => new Promise((resolve) => {
      try {
        const w = img.width, h = img.height;
        if (!w || !h) return resolve(null);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d');
        const id = cx.createImageData(w, h);
        const data = img.data;
        if (img.kind === 3 && data.length >= w * h * 4) {
          id.data.set(data.subarray(0, w * h * 4));
        } else if (img.kind === 2 && data.length >= w * h * 3) {
          for (let i = 0, j = 0; i < w * h; i++) { id.data[j++] = data[i * 3]; id.data[j++] = data[i * 3 + 1]; id.data[j++] = data[i * 3 + 2]; id.data[j++] = 255; }
        } else if (img.kind === 1 && data.length >= w * h) {
          for (let i = 0, j = 0; i < w * h; i++) { const g = data[i]; id.data[j++] = g; id.data[j++] = g; id.data[j++] = g; id.data[j++] = 255; }
        } else if (data && data.length >= w * h * 4) {
          id.data.set(data.subarray(0, w * h * 4));
        } else { return resolve(null); }
        cx.putImageData(id, 0, 0);
        c.toBlob((b) => (b ? b.arrayBuffer().then(resolve, () => resolve(null)) : resolve(null)), 'image/png');
      } catch (_) { resolve(null); }
    });
    $('#btn-extractimg').addEventListener('click', async () => {
      const f = exState.file;
      if (!f) return;
      const btn = $('#btn-extractimg');
      btn.disabled = true;
      hideResult('extractimg');
      try {
        const src = await loadPdfJs(await f.arrayBuffer());
        const found = [];
        const seen = new Set();
        const throwaway = document.createElement('canvas');
        const tctx = throwaway.getContext('2d');
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('extractimg', `Scanning page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          throwaway.width = Math.ceil(vp.width); throwaway.height = Math.ceil(vp.height);
          await page.render({ canvasContext: tctx, viewport: vp }).promise; // forces image objs to resolve
          const ops = await page.getOperatorList();
          for (let k = 0; k < ops.fnArray.length; k++) {
            const fn = ops.fnArray[k];
            if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintJpegXObject) {
              const name = ops.argsArray[k][0];
              if (typeof name !== 'string' || seen.has(i + ':' + name)) continue;
              seen.add(i + ':' + name);
              let img = null;
              try { img = page.objs.get(name); } catch (_) {}
              if (!img) continue;
              const buf = await imgObjToBuf(img);
              if (buf) found.push({ page: i, buf });
            }
          }
          if (page.cleanup) page.cleanup();
        }
        if (!found.length) throw new Error('No extractable embedded images were found. Vector graphics and some compressed image types can’t be pulled out — use PDF to PNG to save whole pages as images instead.');
        if (found.length === 1) {
          showResult('extractimg', new Blob([found[0].buf], { type: 'image/png' }), `${baseName(f.name)}_image.png`, 'image/png', `1 image · ${fmtBytes(found[0].buf.byteLength)}`);
        } else {
          setStatus('extractimg', 'Packing images into a ZIP…');
          const zip = new JSZip();
          const pad = String(found.length).length;
          found.forEach((it, idx) => zip.file(`${baseName(f.name)}_p${it.page}_${String(idx + 1).padStart(pad, '0')}.png`, it.buf));
          const blob = await zip.generateAsync({ type: 'blob' });
          showResult('extractimg', blob, `${baseName(f.name)}_images.zip`, 'application/zip', `${found.length} images · ${fmtBytes(blob.size)}`);
        }
      } catch (err) {
        setStatus('extractimg', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      } finally {
        btn.disabled = !exState.file;
      }
    });
  }

  // ============================================================ ADD PAGES
  if ($('#dz-addpage')) {
    const apState = { file: null, pageCount: 0 };
    setupDropzone('addpage', async ([f]) => {
      hideResult('addpage');
      try {
        setStatus('addpage', 'Reading PDF…');
        apState.pageCount = await readPageCount(await f.arrayBuffer());
        apState.file = f;
        $('#picked-addpage').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${apState.pageCount} pages`;
        if ($('#after-addpage')) $('#after-addpage').max = apState.pageCount;
        $('#btn-addpage').disabled = false;
        setStatus('addpage', '');
      } catch (err) {
        apState.file = null;
        $('#btn-addpage').disabled = true;
        setStatus('addpage', `❌ ${/password/i.test(String(err)) ? PW_NEEDED_MSG : err.message || err}`, 'error');
      }
    });
    $('#btn-addpage').addEventListener('click', async () => {
      const f = apState.file;
      if (!f) return;
      const btn = $('#btn-addpage');
      btn.disabled = true;
      hideResult('addpage');
      try {
        const where = $('#pos-addpage').value;
        const count = Math.min(50, Math.max(1, +$('#count-addpage').value || 1));
        const sizeOpt = $('#size-addpage').value;
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        const total = doc.getPageCount();
        const first = doc.getPage(0).getSize();
        const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
        const dims = sizeOpt === 'match' ? [first.width, first.height] : SIZES[sizeOpt];
        const at = where === 'start' ? 0 : where === 'end' ? total : Math.min(total, Math.max(0, +$('#after-addpage').value || total));
        for (let i = 0; i < count; i++) doc.insertPage(at + i, dims);
        const bytes = await doc.save();
        showResult('addpage', bytes, `${baseName(f.name)}_added.pdf`, 'application/pdf',
          `${count} blank page${count > 1 ? 's' : ''} added · ${total + count} total · ${fmtBytes(bytes.length)}`);
      } catch (err) {
        setStatus('addpage', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = !apState.file;
      }
    });
  }

  // ====================================================== PDF TO POWERPOINT
  // Each page becomes a full-bleed image on its own slide (PptxGenJS, lazy).
  if ($('#dz-pdf2ppt')) {
    const ppState = { file: null };
    setupDropzone('pdf2ppt', ([f]) => {
      ppState.file = f;
      $('#picked-pdf2ppt').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-pdf2ppt').disabled = false;
      hideResult('pdf2ppt');
      setStatus('pdf2ppt', '');
    });
    $('#btn-pdf2ppt').addEventListener('click', async () => {
      const f = ppState.file;
      if (!f) return;
      const btn = $('#btn-pdf2ppt');
      btn.disabled = true;
      hideResult('pdf2ppt');
      try {
        setStatus('pdf2ppt', 'Loading PowerPoint engine…');
        await loadScriptOnce('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js', 'PptxGenJS');
        const Pptx = window.PptxGenJS || window.pptxgen;
        if (!Pptx) throw new Error('PowerPoint engine failed to initialize.');
        const src = await loadPdfJs(await f.arrayBuffer());
        const pptx = new Pptx();
        const a1 = (await src.getPage(1)).getViewport({ scale: 1 });
        const ar1 = a1.width / a1.height;
        const LW = ar1 >= 1 ? 10 : 7.5 * ar1;
        const LH = ar1 >= 1 ? 10 / ar1 : 7.5;
        pptx.defineLayout({ name: 'PDFPAGE', width: LW, height: LH });
        pptx.layout = 'PDFPAGE';
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('pdf2ppt', `Adding slide ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale: 1.7 });
          canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const ar = canvas.width / canvas.height;
          let w = LW, h = LW / ar;
          if (h > LH) { h = LH; w = LH * ar; }
          pptx.addSlide().addImage({ data: canvas.toDataURL('image/jpeg', 0.85), x: (LW - w) / 2, y: (LH - h) / 2, w, h });
        }
        setStatus('pdf2ppt', 'Building .pptx…');
        const blob = await pptx.write('blob');
        showResult('pdf2ppt', blob, `${baseName(f.name)}.pptx`, 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          `${src.numPages} slide${src.numPages > 1 ? 's' : ''} · ${fmtBytes(blob.size)}`);
      } catch (err) {
        setStatus('pdf2ppt', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      } finally {
        btn.disabled = !ppState.file;
      }
    });
  }

  // ========================================================= PDF TO EXCEL
  // Best-effort: rebuilds rows/columns from the text layer (SheetJS, lazy).
  // Digital tables convert well; scanned PDFs need OCR first.
  if ($('#dz-pdf2excel')) {
    const peState = { file: null };
    setupDropzone('pdf2excel', ([f]) => {
      peState.file = f;
      $('#picked-pdf2excel').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-pdf2excel').disabled = false;
      hideResult('pdf2excel');
      setStatus('pdf2excel', '');
    });
    $('#btn-pdf2excel').addEventListener('click', async () => {
      const f = peState.file;
      if (!f) return;
      const btn = $('#btn-pdf2excel');
      btn.disabled = true;
      hideResult('pdf2excel');
      try {
        setStatus('pdf2excel', 'Loading spreadsheet engine…');
        const XLSX = await loadScriptOnce('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'XLSX');
        const src = await loadPdfJs(await f.arrayBuffer());
        const wb = XLSX.utils.book_new();
        let anyText = false;
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('pdf2excel', `Extracting page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const content = await page.getTextContent();
          const items = content.items.filter((t) => t.str.trim() !== '').map((t) => ({ str: t.str, x: t.transform[4], y: t.transform[5] }));
          if (items.length) anyText = true;
          items.sort((a, b) => b.y - a.y || a.x - b.x);
          const rows = [];
          let cur = [], lastY = null;
          for (const it of items) {
            if (lastY === null || Math.abs(it.y - lastY) <= 4) { cur.push(it); lastY = lastY === null ? it.y : (lastY + it.y) / 2; }
            else { rows.push(cur); cur = [it]; lastY = it.y; }
          }
          if (cur.length) rows.push(cur);
          const aoa = rows.map((r) => r.sort((a, b) => a.x - b.x).map((c) => c.str.trim()));
          const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [['']]);
          XLSX.utils.book_append_sheet(wb, ws, `Page ${i}`.slice(0, 31));
        }
        if (!anyText) throw new Error('No selectable text found — this looks like a scanned PDF. Run it through OCR first, then convert.');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        showResult('pdf2excel', new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
          `${baseName(f.name)}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          `${src.numPages} sheet${src.numPages > 1 ? 's' : ''} · ${fmtBytes(wbout.byteLength || wbout.length)}`);
      } catch (err) {
        setStatus('pdf2excel', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      } finally {
        btn.disabled = !peState.file;
      }
    });
  }

  // ========================================================= EXCEL TO PDF
  if ($('#dz-excel2pdf')) {
    const epState = { file: null };
    setupDropzone('excel2pdf', ([f]) => {
      if (!/\.(xlsx|xls|csv)$/i.test(f.name)) { setStatus('excel2pdf', '❌ Please choose an .xlsx, .xls or .csv file.', 'error'); return; }
      epState.file = f;
      $('#picked-excel2pdf').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-excel2pdf').disabled = false;
      hideResult('excel2pdf');
      setStatus('excel2pdf', '');
    });
    $('#btn-excel2pdf').addEventListener('click', async () => {
      const f = epState.file;
      if (!f) return;
      const btn = $('#btn-excel2pdf');
      btn.disabled = true;
      hideResult('excel2pdf');
      try {
        setStatus('excel2pdf', 'Loading spreadsheet engine…');
        const XLSX = await loadScriptOnce('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'XLSX');
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const fontB = await doc.embedFont(StandardFonts.HelveticaBold);
        const PW = 841.89, PH = 595.28, M = 36, size = 8.5, lineH = 13;
        for (const name of wb.SheetNames) {
          const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
          if (!aoa.length) continue;
          const cols = Math.max(...aoa.map((r) => r.length), 1);
          const colW = (PW - 2 * M) / cols;
          let page = doc.addPage([PW, PH]);
          let y = PH - M;
          page.drawText(toWinAnsi(name).slice(0, 90) || ' ', { x: M, y: y - 10, size: 12, font: fontB, color: rgb(0.1, 0.1, 0.1) });
          y -= 28;
          aoa.forEach((row, ri) => {
            if (y < M + lineH) { page = doc.addPage([PW, PH]); y = PH - M; }
            for (let c = 0; c < cols; c++) {
              let s = toWinAnsi(row[c] == null ? '' : String(row[c]));
              while (s && font.widthOfTextAtSize(s, size) > colW - 4) s = s.slice(0, -1);
              if (s) page.drawText(s, { x: M + c * colW + 2, y: y - 10, size, font: ri === 0 ? fontB : font, color: rgb(0.15, 0.15, 0.15) });
            }
            y -= lineH;
          });
        }
        if (doc.getPageCount() === 0) throw new Error('The spreadsheet appears to be empty.');
        const bytes = await doc.save({ useObjectStreams: true });
        showResult('excel2pdf', bytes, `${baseName(f.name)}.pdf`, 'application/pdf',
          `${doc.getPageCount()} page${doc.getPageCount() > 1 ? 's' : ''} · ${fmtBytes(bytes.length)}`);
      } catch (err) {
        setStatus('excel2pdf', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = !epState.file;
      }
    });
  }

  // ============================================ TEXT EXTRACTION HELPERS
  // Shared by the text-export tools. Groups the text layer back into lines.
  const extractPdfLines = async (src) => {
    const pages = [];
    for (let i = 1; i <= src.numPages; i++) {
      const content = await (await src.getPage(i)).getTextContent();
      const lines = [];
      let line = '';
      for (const it of content.items) {
        line += it.str;
        if (it.hasEOL) { lines.push(line); line = ''; }
        else if (it.str && !it.str.endsWith(' ')) line += ' ';
      }
      if (line.trim()) lines.push(line);
      pages.push(lines);
    }
    return pages;
  };

  // ============================================================ PDF TO TEXT
  if ($('#dz-pdf2text')) {
    const st = { file: null };
    setupDropzone('pdf2text', ([f]) => { st.file = f; $('#picked-pdf2text').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-pdf2text').disabled = false; hideResult('pdf2text'); setStatus('pdf2text', ''); });
    $('#btn-pdf2text').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-pdf2text'); btn.disabled = true; hideResult('pdf2text');
      try {
        setStatus('pdf2text', 'Extracting text…');
        const src = await loadPdfJs(await f.arrayBuffer());
        const out = (await extractPdfLines(src)).map((l) => l.join('\n')).join('\n\n');
        if (!out.trim()) throw new Error('No selectable text found — this looks like a scanned PDF. Run it through OCR first.');
        if ($('#out-pdf2text')) $('#out-pdf2text').value = out;
        const blob = new Blob([out], { type: 'text/plain;charset=utf-8' });
        showResult('pdf2text', blob, `${baseName(f.name)}.txt`, 'text/plain', `${src.numPages} page${src.numPages > 1 ? 's' : ''} · ${fmtBytes(blob.size)} of text`);
      } catch (err) { setStatus('pdf2text', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ PDF TO MARKDOWN
  if ($('#dz-pdf2md')) {
    const st = { file: null };
    setupDropzone('pdf2md', ([f]) => { st.file = f; $('#picked-pdf2md').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-pdf2md').disabled = false; hideResult('pdf2md'); setStatus('pdf2md', ''); });
    $('#btn-pdf2md').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-pdf2md'); btn.disabled = true; hideResult('pdf2md');
      try {
        setStatus('pdf2md', 'Converting to Markdown…');
        const src = await loadPdfJs(await f.arrayBuffer());
        const pages = await extractPdfLines(src);
        let md = '';
        pages.forEach((lines, i) => { md += `\n\n## Page ${i + 1}\n\n` + lines.map((l) => l.trim()).filter(Boolean).join('\n\n'); });
        md = md.trim();
        if (!md) throw new Error('No selectable text found — this looks like a scanned PDF. Run it through OCR first.');
        if ($('#out-pdf2md')) $('#out-pdf2md').value = md;
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        showResult('pdf2md', blob, `${baseName(f.name)}.md`, 'text/markdown', `${src.numPages} page${src.numPages > 1 ? 's' : ''} · ${fmtBytes(blob.size)}`);
      } catch (err) { setStatus('pdf2md', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ PDF TO HTML
  if ($('#dz-pdf2html')) {
    const st = { file: null };
    setupDropzone('pdf2html', ([f]) => { st.file = f; $('#picked-pdf2html').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-pdf2html').disabled = false; hideResult('pdf2html'); setStatus('pdf2html', ''); });
    $('#btn-pdf2html').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-pdf2html'); btn.disabled = true; hideResult('pdf2html');
      try {
        setStatus('pdf2html', 'Converting to HTML…');
        const src = await loadPdfJs(await f.arrayBuffer());
        const pages = await extractPdfLines(src);
        if (!pages.some((p) => p.some((l) => l.trim()))) throw new Error('No selectable text found — this looks like a scanned PDF. Run it through OCR first.');
        const body = pages.map((lines, i) => `<section>\n<h2>Page ${i + 1}</h2>\n` + lines.map((l) => `<p>${escapeHtml(l.trim()) || '&nbsp;'}</p>`).join('\n') + `\n</section>`).join('\n');
        const html = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(baseName(f.name))}</title>\n<style>body{font-family:system-ui,Arial,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1e293b}h2{margin-top:2rem;color:#2563eb}p{margin:.4rem 0}</style></head>\n<body>\n${body}\n</body></html>`;
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        showResult('pdf2html', blob, `${baseName(f.name)}.html`, 'text/html', `${src.numPages} page${src.numPages > 1 ? 's' : ''} · ${fmtBytes(blob.size)}`);
      } catch (err) { setStatus('pdf2html', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ TEXT TO PDF
  if ($('#dz-text2pdf')) {
    const st = { file: null };
    const ta = () => $('#text-text2pdf');
    const ready = () => { $('#btn-text2pdf').disabled = !(ta() && ta().value.trim()); };
    if (ta()) ta().addEventListener('input', ready);
    setupDropzone('text2pdf', async ([f]) => { st.file = f; if (ta()) ta().value = await f.text(); $('#picked-text2pdf').textContent = `Loaded: ${f.name}`; hideResult('text2pdf'); setStatus('text2pdf', ''); ready(); });
    $('#btn-text2pdf').addEventListener('click', async () => {
      const raw = ta() ? ta().value : ''; if (!raw.trim()) { setStatus('text2pdf', 'Paste or type some text first.', 'error'); return; }
      const btn = $('#btn-text2pdf'); btn.disabled = true; hideResult('text2pdf');
      try {
        setStatus('text2pdf', 'Building PDF…');
        const doc = await PDFDocument.create();
        const thai = hasThai(raw);
        const font = thai ? await getUnicodeFont(doc) : await doc.embedFont(StandardFonts.Helvetica);
        const PW = 595.28, PH = 841.89, M = 56, size = 11.5, lineH = size * 1.5;
        let page = doc.addPage([PW, PH]); let y = PH - M;
        for (const para of raw.split('\n')) {
          const text = thai ? para : toWinAnsi(para);
          if (!text.trim()) { y -= lineH * 0.7; if (y < M) { page = doc.addPage([PW, PH]); y = PH - M; } continue; }
          for (const ln of wrapText(text, font, size, PW - 2 * M)) {
            if (y < M + size) { page = doc.addPage([PW, PH]); y = PH - M; }
            page.drawText(ln, { x: M, y: y - size, size, font, color: rgb(0.1, 0.1, 0.15) });
            y -= lineH;
          }
        }
        const bytes = await doc.save({ useObjectStreams: true });
        showResult('text2pdf', bytes, 'text.pdf', 'application/pdf', `${doc.getPageCount()} page${doc.getPageCount() > 1 ? 's' : ''} · ${fmtBytes(bytes.length)}`);
      } catch (err) { setStatus('text2pdf', `❌ ${err.message || err}`, 'error'); } finally { ready(); }
    });
  }

  // ============================================================ WORD COUNTER
  if ($('#dz-wordcount')) {
    const st = { file: null };
    setupDropzone('wordcount', ([f]) => { st.file = f; $('#picked-wordcount').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-wordcount').disabled = false; hideResult('wordcount'); setStatus('wordcount', ''); });
    $('#btn-wordcount').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-wordcount'); btn.disabled = true; hideResult('wordcount');
      try {
        const src = await loadPdfJs(await f.arrayBuffer());
        let txt = '';
        for (let i = 1; i <= src.numPages; i++) { setStatus('wordcount', `Reading page ${i} of ${src.numPages}…`); const c = await (await src.getPage(i)).getTextContent(); txt += c.items.map((it) => it.str).join(' ') + ' '; }
        const words = (txt.match(/\S+/g) || []).length;
        const chars = txt.replace(/\s/g, '').length;
        const report = `Words: ${words}\nCharacters (no spaces): ${chars}\nCharacters (with spaces): ${txt.length}\nPages: ${src.numPages}\nAverage words per page: ${Math.round(words / src.numPages)}`;
        if ($('#out-wordcount')) $('#out-wordcount').value = report;
        const blob = new Blob([report], { type: 'text/plain' });
        showResult('wordcount', blob, `${baseName(f.name)}_wordcount.txt`, 'text/plain', `${words.toLocaleString()} words · ${src.numPages} pages`);
      } catch (err) { setStatus('wordcount', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ VIEW METADATA
  if ($('#dz-metaview')) {
    const st = { file: null };
    setupDropzone('metaview', ([f]) => { st.file = f; $('#picked-metaview').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-metaview').disabled = false; hideResult('metaview'); setStatus('metaview', ''); });
    $('#btn-metaview').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-metaview'); btn.disabled = true; hideResult('metaview');
      try {
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        const g = (fn) => { try { const v = fn(); return v == null || v === '' ? '—' : v; } catch (_) { return '—'; } };
        const d = (fn) => { try { const v = fn(); return v ? v.toISOString().slice(0, 10) : '—'; } catch (_) { return '—'; } };
        const report = [
          `Title: ${g(() => doc.getTitle())}`, `Author: ${g(() => doc.getAuthor())}`, `Subject: ${g(() => doc.getSubject())}`,
          `Keywords: ${g(() => doc.getKeywords())}`, `Creator: ${g(() => doc.getCreator())}`, `Producer: ${g(() => doc.getProducer())}`,
          `Created: ${d(() => doc.getCreationDate())}`, `Modified: ${d(() => doc.getModificationDate())}`, `Pages: ${doc.getPageCount()}`,
        ].join('\n');
        if ($('#out-metaview')) $('#out-metaview').value = report;
        const blob = new Blob([report], { type: 'text/plain' });
        showResult('metaview', blob, `${baseName(f.name)}_metadata.txt`, 'text/plain', `${doc.getPageCount()} pages`);
      } catch (err) { setStatus('metaview', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ EDIT METADATA
  if ($('#dz-metaedit')) {
    const st = { file: null };
    setupDropzone('metaedit', async ([f]) => {
      st.file = f; $('#picked-metaedit').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-metaedit').disabled = false; hideResult('metaedit'); setStatus('metaedit', '');
      try { const doc = await loadPdfForEdit(await f.arrayBuffer()); const s = (id, v) => { if ($(id)) $(id).value = v || ''; }; s('#meta-title', doc.getTitle()); s('#meta-author', doc.getAuthor()); s('#meta-subject', doc.getSubject()); s('#meta-keywords', doc.getKeywords()); } catch (_) {}
    });
    $('#btn-metaedit').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-metaedit'); btn.disabled = true; hideResult('metaedit');
      try {
        setStatus('metaedit', 'Updating metadata…');
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        doc.setTitle($('#meta-title').value || ''); doc.setAuthor($('#meta-author').value || ''); doc.setSubject($('#meta-subject').value || '');
        doc.setKeywords(($('#meta-keywords').value || '').split(',').map((s) => s.trim()).filter(Boolean));
        const bytes = await doc.save();
        showResult('metaedit', bytes, `${baseName(f.name)}_metadata.pdf`, 'application/pdf', 'Metadata updated');
      } catch (err) { setStatus('metaedit', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ REMOVE METADATA
  if ($('#dz-metaremove')) {
    const st = { file: null };
    setupDropzone('metaremove', ([f]) => { st.file = f; $('#picked-metaremove').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-metaremove').disabled = false; hideResult('metaremove'); setStatus('metaremove', ''); });
    $('#btn-metaremove').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-metaremove'); btn.disabled = true; hideResult('metaremove');
      try {
        setStatus('metaremove', 'Stripping metadata…');
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]); doc.setProducer(''); doc.setCreator('');
        const bytes = await doc.save();
        showResult('metaremove', bytes, `${baseName(f.name)}_clean.pdf`, 'application/pdf', 'Metadata removed');
      } catch (err) { setStatus('metaremove', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ FLATTEN PDF
  if ($('#dz-flatten')) {
    const st = { file: null };
    setupDropzone('flatten', ([f]) => { st.file = f; $('#picked-flatten').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-flatten').disabled = false; hideResult('flatten'); setStatus('flatten', ''); });
    $('#btn-flatten').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-flatten'); btn.disabled = true; hideResult('flatten');
      try {
        setStatus('flatten', 'Flattening form fields…');
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        let fields = 0;
        try { const form = doc.getForm(); fields = form.getFields().length; form.flatten(); } catch (_) {}
        const bytes = await doc.save();
        showResult('flatten', bytes, `${baseName(f.name)}_flattened.pdf`, 'application/pdf', fields ? `${fields} form field${fields > 1 ? 's' : ''} flattened` : 'Saved (no form fields found)');
      } catch (err) { setStatus('flatten', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ===================================================== REMOVE ANNOTATIONS
  if ($('#dz-unannotate')) {
    const { PDFName } = PDFLib;
    const st = { file: null };
    setupDropzone('unannotate', ([f]) => { st.file = f; $('#picked-unannotate').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-unannotate').disabled = false; hideResult('unannotate'); setStatus('unannotate', ''); });
    $('#btn-unannotate').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-unannotate'); btn.disabled = true; hideResult('unannotate');
      try {
        setStatus('unannotate', 'Removing comments & annotations…');
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        let n = 0;
        doc.getPages().forEach((p) => { if (p.node.get(PDFName.of('Annots'))) { p.node.delete(PDFName.of('Annots')); n++; } });
        const bytes = await doc.save();
        showResult('unannotate', bytes, `${baseName(f.name)}_no_annotations.pdf`, 'application/pdf', n ? `Cleared annotations on ${n} page${n > 1 ? 's' : ''}` : 'No annotations found');
      } catch (err) { setStatus('unannotate', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ REVERSE PAGES
  if ($('#dz-reverse')) {
    const st = { file: null };
    setupDropzone('reverse', ([f]) => { st.file = f; $('#picked-reverse').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-reverse').disabled = false; hideResult('reverse'); setStatus('reverse', ''); });
    $('#btn-reverse').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-reverse'); btn.disabled = true; hideResult('reverse');
      try {
        setStatus('reverse', 'Reversing page order…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        (await out.copyPages(src, src.getPageIndices().reverse())).forEach((p) => out.addPage(p));
        const bytes = await out.save({ useObjectStreams: true });
        showResult('reverse', bytes, `${baseName(f.name)}_reversed.pdf`, 'application/pdf', `${out.getPageCount()} pages reversed`);
      } catch (err) { setStatus('reverse', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ DUPLICATE PAGES
  if ($('#dz-duplicate')) {
    const st = { file: null };
    setupDropzone('duplicate', ([f]) => { st.file = f; $('#picked-duplicate').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-duplicate').disabled = false; hideResult('duplicate'); setStatus('duplicate', ''); });
    $('#btn-duplicate').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-duplicate'); btn.disabled = true; hideResult('duplicate');
      try {
        const copies = Math.min(10, Math.max(2, +$('#copies-duplicate').value || 2));
        setStatus('duplicate', 'Duplicating pages…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        for (let i = 0; i < src.getPageCount(); i++) (await out.copyPages(src, Array(copies).fill(i))).forEach((p) => out.addPage(p));
        const bytes = await out.save({ useObjectStreams: true });
        showResult('duplicate', bytes, `${baseName(f.name)}_duplicated.pdf`, 'application/pdf', `Each page ×${copies} · ${out.getPageCount()} pages`);
      } catch (err) { setStatus('duplicate', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ INTERLEAVE PDF
  if ($('#dz-interleave')) {
    const st = { files: [] };
    setupDropzone('interleave', (files) => {
      st.files = files.filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf').slice(0, 2);
      $('#picked-interleave').textContent = st.files.length ? `Selected: ${st.files.map((f) => f.name).join(', ')}` : '';
      $('#btn-interleave').disabled = st.files.length !== 2; hideResult('interleave'); setStatus('interleave', st.files.length === 1 ? 'Add one more PDF (drop both, or click to add the second).' : '');
    });
    $('#btn-interleave').addEventListener('click', async () => {
      if (st.files.length !== 2) return; const btn = $('#btn-interleave'); btn.disabled = true; hideResult('interleave');
      try {
        setStatus('interleave', 'Interleaving pages…');
        const a = await loadPdfForEdit(await st.files[0].arrayBuffer());
        const b = await loadPdfForEdit(await st.files[1].arrayBuffer());
        const out = await PDFDocument.create();
        const na = a.getPageCount(), nb = b.getPageCount();
        for (let i = 0; i < Math.max(na, nb); i++) {
          if (i < na) (await out.copyPages(a, [i])).forEach((p) => out.addPage(p));
          if (i < nb) (await out.copyPages(b, [i])).forEach((p) => out.addPage(p));
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('interleave', bytes, 'interleaved.pdf', 'application/pdf', `${out.getPageCount()} pages`);
      } catch (err) { setStatus('interleave', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = st.files.length !== 2; }
    });
  }

  // ============================================================ ZIP PDF FILES
  if ($('#dz-zippdf')) {
    const st = { files: [] };
    setupDropzone('zippdf', (files) => {
      st.files = files.filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf');
      $('#picked-zippdf').textContent = st.files.length ? `${st.files.length} PDF${st.files.length > 1 ? 's' : ''} selected` : '';
      $('#btn-zippdf').disabled = st.files.length < 2; hideResult('zippdf'); setStatus('zippdf', '');
    });
    $('#btn-zippdf').addEventListener('click', async () => {
      if (st.files.length < 2) return; const btn = $('#btn-zippdf'); btn.disabled = true; hideResult('zippdf');
      try {
        setStatus('zippdf', 'Zipping files…');
        const zip = new JSZip();
        for (const f of st.files) zip.file(f.name.replace(/[\/\\]/g, '_'), await f.arrayBuffer());
        const blob = await zip.generateAsync({ type: 'blob' });
        showResult('zippdf', blob, 'pdfs.zip', 'application/zip', `${st.files.length} files · ${fmtBytes(blob.size)}`);
      } catch (err) { setStatus('zippdf', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = st.files.length < 2; }
    });
  }

  // ============================================================ RESIZE PDF
  if ($('#dz-resize')) {
    const st = { file: null };
    setupDropzone('resize', ([f]) => { st.file = f; $('#picked-resize').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-resize').disabled = false; hideResult('resize'); setStatus('resize', ''); });
    $('#btn-resize').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-resize'); btn.disabled = true; hideResult('resize');
      try {
        const SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a3: [841.89, 1190.55], a5: [419.53, 595.28] };
        const key = $('#size-resize').value; const [TW, TH] = SIZES[key] || SIZES.a4;
        setStatus('resize', 'Resizing pages…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        for (let i = 0; i < src.getPageCount(); i++) {
          const sp = src.getPage(i); const emb = await out.embedPage(sp);
          const sw = sp.getWidth(), sh = sp.getHeight(); const portrait = sh >= sw;
          const [pw, ph] = portrait ? [TW, TH] : [TH, TW];
          const scale = Math.min(pw / sw, ph / sh); const w = sw * scale, h = sh * scale;
          const page = out.addPage([pw, ph]);
          page.drawPage(emb, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('resize', bytes, `${baseName(f.name)}_${key}.pdf`, 'application/pdf', `Resized to ${key.toUpperCase()} · ${out.getPageCount()} pages`);
      } catch (err) { setStatus('resize', `❌ ${err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ===================================================== INVERT COLORS / DARK MODE
  if ($('#dz-invert')) {
    const st = { file: null };
    setupDropzone('invert', ([f]) => { st.file = f; $('#picked-invert').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-invert').disabled = false; hideResult('invert'); setStatus('invert', ''); });
    $('#btn-invert').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-invert'); btn.disabled = true; hideResult('invert');
      try {
        const src = await loadPdfJs(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('invert', `Inverting page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i); const vp1 = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: 2 });
          canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const im = ctx.getImageData(0, 0, canvas.width, canvas.height); const dd = im.data;
          for (let p = 0; p < dd.length; p += 4) { dd[p] = 255 - dd[p]; dd[p + 1] = 255 - dd[p + 1]; dd[p + 2] = 255 - dd[p + 2]; }
          ctx.putImageData(im, 0, 0);
          const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.85));
          out.addPage([vp1.width, vp1.height]).drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('invert', bytes, `${baseName(f.name)}_inverted.pdf`, 'application/pdf', `${src.numPages} page${src.numPages > 1 ? 's' : ''} · dark mode`);
      } catch (err) { setStatus('invert', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error'); } finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ FLIP / MIRROR
  if ($('#dz-flip')) {
    const st = { file: null, pageCount: 0 };
    setupDropzone('flip', async ([f]) => {
      hideResult('flip');
      try {
        setStatus('flip', 'Reading PDF…');
        st.pageCount = await readPageCount(await f.arrayBuffer());
        st.file = f;
        $('#picked-flip').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${st.pageCount} pages`;
        $('#btn-flip').disabled = false;
        setStatus('flip', '');
      } catch (err) {
        st.file = null; $('#btn-flip').disabled = true;
        setStatus('flip', `❌ ${err.message || err}`, 'error');
      }
    });
    $('#btn-flip').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-flip'); btn.disabled = true; hideResult('flip');
      try {
        const dir = $('#dir-flip').value;
        const rangeStr = $('#range-flip').value;
        const targets = rangeStr.trim()
          ? parseRanges(rangeStr, st.pageCount)
          : Array.from({ length: st.pageCount }, (_, i) => i + 1);
        if (!targets) throw new Error(`Enter a valid page range between 1 and ${st.pageCount}.`);
        setStatus('flip', 'Flipping pages…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const embeddedPages = await out.embedPages(src.getPages());
        const mirrorH = dir === 'horizontal' || dir === 'both';
        const mirrorV = dir === 'vertical' || dir === 'both';
        for (let i = 0; i < st.pageCount; i++) {
          const srcPage = src.getPage(i);
          const { width, height } = srcPage.getSize();
          const page = out.addPage([width, height]);
          const shouldFlip = targets.includes(i + 1);
          page.drawPage(embeddedPages[i], {
            x: (shouldFlip && mirrorH) ? width : 0,
            y: (shouldFlip && mirrorV) ? height : 0,
            width: width,
            height: height,
            xScale: (shouldFlip && mirrorH) ? -1 : 1,
            yScale: (shouldFlip && mirrorV) ? -1 : 1,
          });
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('flip', bytes, `${baseName(f.name)}_flipped.pdf`, 'application/pdf', `Mirrored ${targets.length} pages`);
      } catch (err) { setStatus('flip', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ PDF TO SCANNED LOOK
  if ($('#dz-scanned')) {
    const st = { file: null };
    setupDropzone('scanned', ([f]) => {
      st.file = f; $('#picked-scanned').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-scanned').disabled = false; hideResult('scanned'); setStatus('scanned', '');
    });
    $('#btn-scanned').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-scanned'); btn.disabled = true; hideResult('scanned');
      try {
        setStatus('scanned', 'Initializing scan emulator…');
        const dpi = +$('#res-scanned').value || 150;
        const scale = dpi === 72 ? 1.0 : dpi === 150 ? 2.0 : 2.7;
        const skew = $('#skew-scanned').value;
        const noise = $('#noise-scanned').value;
        const isGrayscale = $('#color-scanned').value === 'grayscale';
        const src = await loadPdfJs(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const renderCanvas = document.createElement('canvas');
        const renderCtx = renderCanvas.getContext('2d');
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('scanned', `Processing page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale });
          renderCanvas.width = Math.ceil(vp.width);
          renderCanvas.height = Math.ceil(vp.height);
          renderCtx.fillStyle = '#ffffff';
          renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
          await page.render({ canvasContext: renderCtx, viewport: vp }).promise;
          let canvas = renderCanvas;
          let ctx = renderCtx;
          if (skew !== 'none') {
            const skewCanvas = document.createElement('canvas');
            skewCanvas.width = renderCanvas.width;
            skewCanvas.height = renderCanvas.height;
            const skewCtx = skewCanvas.getContext('2d');
            skewCtx.fillStyle = '#ffffff';
            skewCtx.fillRect(0, 0, skewCanvas.width, skewCanvas.height);
            const angleDeg = skew === 'slight' ? (Math.random() * 0.6 - 0.3) : (Math.random() * 1.6 - 0.8);
            skewCtx.translate(skewCanvas.width / 2, skewCanvas.height / 2);
            skewCtx.rotate((angleDeg * Math.PI) / 180);
            skewCtx.drawImage(renderCanvas, -renderCanvas.width / 2, -renderCanvas.height / 2);
            canvas = skewCanvas;
            ctx = skewCtx;
          }
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = imgData.data;
          const len = d.length;
          const contrastFactor = noise === 'none' ? 1.0 : noise === 'slight' ? 1.3 : noise === 'medium' ? 1.6 : 2.0;
          for (let j = 0; j < len; j += 4) {
            let r = d[j], g = d[j+1], b = d[j+2];
            if (isGrayscale) {
              const gray = 0.299 * r + 0.587 * g + 0.114 * b;
              r = g = b = gray;
            }
            if (contrastFactor !== 1.0) {
              r = Math.min(255, Math.max(0, contrastFactor * (r - 128) + 128));
              g = Math.min(255, Math.max(0, contrastFactor * (g - 128) + 128));
              b = Math.min(255, Math.max(0, contrastFactor * (b - 128) + 128));
            }
            d[j] = r; d[j+1] = g; d[j+2] = b;
          }
          ctx.putImageData(imgData, 0, 0);
          if (noise !== 'none') {
            const specks = noise === 'slight' ? 600 : noise === 'medium' ? 2500 : 8000;
            ctx.fillStyle = 'rgba(50, 50, 50, 0.2)';
            for (let s = 0; s < specks; s++) {
               const sx = Math.random() * canvas.width;
               const sy = Math.random() * canvas.height;
               const sr = Math.random() * (noise === 'heavy' ? 2.0 : 1.2);
               ctx.beginPath();
               ctx.arc(sx, sy, sr, 0, 2 * Math.PI);
               ctx.fill();
            }
          }
          const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.70));
          const p = out.addPage([vp1.width, vp1.height]);
          p.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('scanned', bytes, `${baseName(f.name)}_scanned.pdf`, 'application/pdf', `Scanned look · ${src.numPages} pages`);
      } catch (err) { setStatus('scanned', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ SINGLE LONG PAGE
  if ($('#dz-longpage')) {
    const st = { file: null };
    setupDropzone('longpage', ([f]) => {
      st.file = f; $('#picked-longpage').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-longpage').disabled = false; hideResult('longpage'); setStatus('longpage', '');
    });
    $('#btn-longpage').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-longpage'); btn.disabled = true; hideResult('longpage');
      try {
        const spacing = +$('#gap-longpage').value || 0;
        setStatus('longpage', 'Stitching pages vertically…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const numPages = src.getPageCount();
        if (numPages === 0) throw new Error('PDF has no pages.');
        const embeddedPages = await out.embedPages(src.getPages());
        let totalHeight = 0;
        let maxWidth = 0;
        for (let i = 0; i < numPages; i++) {
          const { width, height } = src.getPage(i).getSize();
          totalHeight += height;
          if (width > maxWidth) maxWidth = width;
        }
        totalHeight += spacing * (numPages - 1);
        const page = out.addPage([maxWidth, totalHeight]);
        let curY = totalHeight;
        for (let i = 0; i < numPages; i++) {
          const pSize = src.getPage(i).getSize();
          curY -= pSize.height;
          const curX = (maxWidth - pSize.width) / 2;
          page.drawPage(embeddedPages[i], {
            x: curX,
            y: curY,
            width: pSize.width,
            height: pSize.height
          });
          curY -= spacing;
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('longpage', bytes, `${baseName(f.name)}_longpage.pdf`, 'application/pdf', `Continuous sheet · ${numPages} source pages`);
      } catch (err) { setStatus('longpage', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ SPLIT HORIZONTALLY / VERTICALLY
  if ($('#dz-split-horiz')) {
    const st = { file: null, pageCount: 0 };
    setupDropzone('split-horiz', async ([f]) => {
      hideResult('split-horiz');
      try {
        setStatus('split-horiz', 'Reading PDF…');
        st.pageCount = await readPageCount(await f.arrayBuffer());
        st.file = f;
        $('#picked-split-horiz').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${st.pageCount} pages`;
        $('#btn-split-horiz').disabled = false;
        setStatus('split-horiz', '');
      } catch (err) {
        st.file = null; $('#btn-split-horiz').disabled = true;
        setStatus('split-horiz', `❌ ${err.message || err}`, 'error');
      }
    });
    $('#btn-split-horiz').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-split-horiz'); btn.disabled = true; hideResult('split-horiz');
      try {
        const mode = $('#mode-split-horiz').value;
        setStatus('split-horiz', 'Splitting page sheets…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        for (let i = 0; i < st.pageCount; i++) {
          const [leftPage, rightPage] = await out.copyPages(src, [i, i]);
          const mb = src.getPage(i).getMediaBox();
          if (mode === 'horizontal') {
            leftPage.setCropBox(mb.x, mb.y + mb.height / 2, mb.width, mb.height / 2);
            rightPage.setCropBox(mb.x, mb.y, mb.width, mb.height / 2);
          } else {
            leftPage.setCropBox(mb.x, mb.y, mb.width / 2, mb.height);
            rightPage.setCropBox(mb.x + mb.width / 2, mb.y, mb.width / 2, mb.height);
          }
          out.addPage(leftPage);
          out.addPage(rightPage);
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('split-horiz', bytes, `${baseName(f.name)}_split_${mode}.pdf`, 'application/pdf', `Split into ${out.getPageCount()} pages`);
      } catch (err) { setStatus('split-horiz', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ ADD COVER PAGE
  if ($('#dz-addcover')) {
    const st = { file: null, coverImgDataUrl: null };
    setupDropzone('addcover', ([f]) => {
      st.file = f; $('#picked-addcover').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-addcover').disabled = false; hideResult('addcover'); setStatus('addcover', '');
    });
    $('#style-addcover').addEventListener('change', () => {
      const isImage = $('#style-addcover').value === 'image';
      $('#cover-img-box').classList.toggle('hidden', !isImage);
    });
    $('#cover-img-input').addEventListener('change', () => {
      const f = $('#cover-img-input').files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        st.coverImgDataUrl = r.result;
        $('#cover-img-preview').textContent = `Selected cover: ${f.name}`;
      };
      r.readAsDataURL(f);
    });
    $('#btn-addcover').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-addcover'); btn.disabled = true; hideResult('addcover');
      try {
        const title = $('#title-addcover').value.trim() || 'My Presentation';
        const subtitle = $('#sub-addcover').value.trim();
        const author = $('#author-addcover').value.trim();
        const date = $('#date-addcover').value.trim();
        const coverStyle = $('#style-addcover').value;
        setStatus('addcover', 'Generating cover page…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const firstPage = src.getPage(0);
        const { width: W, height: H } = firstPage.getSize();
        const cover = out.addPage([W, H]);
        if (coverStyle === 'image' && st.coverImgDataUrl) {
          const imgBytes = await (await fetch(st.coverImgDataUrl)).arrayBuffer();
          const img = st.coverImgDataUrl.includes('png') ? await out.embedPng(imgBytes) : await out.embedJpg(imgBytes);
          cover.drawImage(img, { x: 0, y: 0, width: W, height: H });
        } else {
          let fillBg = rgb(1, 1, 1);
          let fillText = rgb(0.07, 0.09, 0.15);
          let fillSub = rgb(0.4, 0.45, 0.55);
          if (coverStyle === 'navy') {
            fillBg = rgb(0.09, 0.17, 0.36); fillText = rgb(1, 1, 1); fillSub = rgb(0.7, 0.75, 0.85);
          } else if (coverStyle === 'forest') {
            fillBg = rgb(0.02, 0.3, 0.2); fillText = rgb(1, 1, 1); fillSub = rgb(0.75, 0.85, 0.8);
          } else if (coverStyle === 'sunset') {
            fillBg = rgb(0.49, 0.11, 0.11); fillText = rgb(1, 1, 1); fillSub = rgb(0.9, 0.75, 0.75);
          }
          cover.drawRectangle({ x: 0, y: 0, width: W, height: H, color: fillBg });
          const fontReg = await out.embedFont(StandardFonts.Helvetica);
          const fontBold = await out.embedFont(StandardFonts.HelveticaBold);
          cover.drawText(toWinAnsi(title), { x: 50, y: H * 0.55, size: 32, font: fontBold, color: fillText });
          if (subtitle) cover.drawText(toWinAnsi(subtitle), { x: 50, y: H * 0.48, size: 16, font: fontReg, color: fillSub });
          let footerY = 70;
          if (author) {
            cover.drawText(`By ${toWinAnsi(author)}`, { x: 50, y: footerY, size: 12, font: fontBold, color: fillSub });
            footerY -= 20;
          }
          if (date) cover.drawText(toWinAnsi(date), { x: 50, y: footerY, size: 11, font: fontReg, color: fillSub });
        }
        const copiedPages = await out.copyPages(src, src.getPageIndices());
        copiedPages.forEach((p) => out.addPage(p));
        const bytes = await out.save({ useObjectStreams: true });
        showResult('addcover', bytes, `${baseName(f.name)}_with_cover.pdf`, 'application/pdf', `${out.getPageCount()} pages total`);
      } catch (err) { setStatus('addcover', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ REMOVE BLANK PAGES
  if ($('#dz-removeblank')) {
    const st = { file: null, pageCount: 0, checkedPages: [] };
    setupDropzone('removeblank', async ([f]) => {
      hideResult('removeblank');
      try {
        setStatus('removeblank', 'Scanning pages for empty space…');
        st.file = f;
        const src = await loadPdfJs(await f.arrayBuffer());
        st.pageCount = src.numPages;
        st.checkedPages = Array(st.pageCount).fill(true);
        const thumbs = $('#thumbs-removeblank');
        thumbs.innerHTML = '';
        $('#work-removeblank').classList.remove('hidden');
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('removeblank', `Analyzing page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale: 0.25 });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const im = ctx.getImageData(0, 0, c.width, c.height);
          const d = im.data;
          let nonWhitePixels = 0;
          for (let p = 0; p < d.length; p += 4) {
            const r = d[p], g = d[p+1], b = d[p+2];
            if (r < 240 || g < 240 || b < 240) nonWhitePixels++;
          }
          const ratio = nonWhitePixels / (c.width * c.height);
          const isBlank = ratio < 0.003;
          st.checkedPages[i-1] = !isBlank;
          const div = document.createElement('div');
          div.className = 'relative border border-slate-200 rounded-lg p-1 bg-white flex flex-col items-center';
          c.className = 'w-full h-auto rounded';
          div.appendChild(c);
          const lbl = document.createElement('label');
          lbl.className = 'mt-1 flex items-center gap-1.5 text-xs font-semibold cursor-pointer';
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.checked = !isBlank;
          chk.className = 'accent-brand-600';
          chk.addEventListener('change', () => { st.checkedPages[i-1] = chk.checked; });
          lbl.appendChild(chk);
          lbl.appendChild(document.createTextNode(`Page ${i}${isBlank ? ' (Blank)' : ''}`));
          div.appendChild(lbl);
          thumbs.appendChild(div);
        }
        $('#picked-removeblank').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — blank pages unchecked by default`;
        $('#btn-removeblank').disabled = false;
        setStatus('removeblank', '');
      } catch (err) {
        setStatus('removeblank', `❌ ${err.message || err}`, 'error');
      }
    });
    $('#btn-removeblank').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-removeblank'); btn.disabled = true; hideResult('removeblank');
      try {
        const keep = [];
        for (let i = 0; i < st.pageCount; i++) if (st.checkedPages[i]) keep.push(i);
        if (keep.length === 0) throw new Error('You must keep at least one page.');
        setStatus('removeblank', `Saving PDF with ${keep.length} page(s)…`);
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        (await out.copyPages(src, keep)).forEach((p) => out.addPage(p));
        const bytes = await out.save({ useObjectStreams: true });
        showResult('removeblank', bytes, `${baseName(f.name)}_cleaned.pdf`, 'application/pdf', `${st.pageCount - keep.length} blank page(s) removed`);
      } catch (err) { setStatus('removeblank', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ PDF TO WEBP
  if ($('#dz-pdf2webp')) {
    const st = { file: null };
    setupDropzone('pdf2webp', ([f]) => {
      st.file = f; $('#picked-pdf2webp').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`; $('#btn-pdf2webp').disabled = false; hideResult('pdf2webp'); setStatus('pdf2webp', '');
    });
    $('#quality-pdf2webp').addEventListener('input', () => {
      $('#quality-pdf2webp-val').textContent = `${$('#quality-pdf2webp').value}%`;
    });
    $('#btn-pdf2webp').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-pdf2webp'); btn.disabled = true; hideResult('pdf2webp');
      try {
        const quality = (+$('#quality-pdf2webp').value || 80) / 100;
        setStatus('pdf2webp', 'Rendering pages to WebP…');
        const src = await loadPdfJs(await f.arrayBuffer());
        const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
        const blobs = [];
        for (let i = 1; i <= src.numPages; i++) {
          setStatus('pdf2webp', `Rendering page ${i} of ${src.numPages}…`);
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale: 2 });
          canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', quality));
          blobs.push(blob);
        }
        if (blobs.length === 1) {
          showResult('pdf2webp', blobs[0], `${baseName(f.name)}.webp`, 'image/webp');
        } else {
          setStatus('pdf2webp', 'Packing WebP images into a ZIP…');
          const zip = new JSZip();
          const pad = String(blobs.length).length;
          blobs.forEach((b, i) => zip.file(`${baseName(f.name)}_page_${String(i+1).padStart(pad, '0')}.webp`, b));
          const zipBlob = await zip.generateAsync({ type: 'blob' });
          showResult('pdf2webp', zipBlob, `${baseName(f.name)}_webp.zip`, 'application/zip', `${blobs.length} WebP images · ${fmtBytes(zipBlob.size)}`);
        }
      } catch (err) { setStatus('pdf2webp', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ SVG TO PDF
  if ($('#dz-svg2pdf')) {
    const st = { files: [] };
    const renderSvgList = () => {
      const ul = $('#files-svg2pdf'); ul.innerHTML = '';
      st.files.forEach((f, i) => {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm';
        li.innerHTML = `<span class="font-medium truncate">${escapeHtml(f.name)}</span>
          <span class="text-slate-400 whitespace-nowrap">${fmtBytes(f.size)}</span>
          <button data-act="rm" data-i="${i}" class="ml-auto border border-red-200 text-red-700 rounded-lg px-2.5 py-0.5 hover:bg-red-50">✕</button>`;
        ul.appendChild(li);
      });
      $('#btn-svg2pdf').disabled = st.files.length === 0;
    };
    $('#files-svg2pdf').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act="rm"]'); if (!btn) return;
      st.files.splice(+btn.dataset.i, 1); renderSvgList();
    });
    setupDropzone('svg2pdf', (files) => {
      const svgs = files.filter((f) => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml');
      if (!svgs.length) { setStatus('svg2pdf', '❌ Please choose standard SVG files.', 'error'); return; }
      st.files.push(...svgs); hideResult('svg2pdf'); setStatus('svg2pdf', ''); renderSvgList();
    });
    $('#btn-svg2pdf').addEventListener('click', async () => {
      const btn = $('#btn-svg2pdf'); btn.disabled = true; hideResult('svg2pdf');
      try {
        const mode = $('#layout-svg2pdf').value;
        const out = await PDFDocument.create();
        const A4 = [595.28, 841.89];
        for (let i = 0; i < st.files.length; i++) {
          const f = st.files[i];
          setStatus('svg2pdf', `Converting SVG ${i + 1} of ${st.files.length}…`);
          const text = await f.text();
          const blob = new Blob([text], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res; img.onerror = () => rej(new Error(`Failed to load SVG "${f.name}".`));
            img.src = url;
          });
          const width = img.naturalWidth || 600;
          const height = img.naturalHeight || 800;
          const canvas = document.createElement('canvas');
          const scaleFactor = 2000 / Math.max(width, height);
          canvas.width = Math.ceil(width * scaleFactor);
          canvas.height = Math.ceil(height * scaleFactor);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = 'rgba(255,255,255,0)';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          const pngBytes = await new Promise((res) => canvas.toBlob(res, 'image/png'));
          const embeddedImg = await out.embedPng(await pngBytes.arrayBuffer());
          if (mode === 'fit') {
            const page = out.addPage([width, height]);
            page.drawImage(embeddedImg, { x: 0, y: 0, width, height });
          } else {
            const page = out.addPage(A4);
            const scale = Math.min((A4[0] - 72) / width, (A4[1] - 72) / height);
            const w = width * scale, h = height * scale;
            page.drawImage(embeddedImg, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
          }
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('svg2pdf', bytes, 'svg_converted.pdf', 'application/pdf', `${st.files.length} SVG(s) compiled`);
      } catch (err) { setStatus('svg2pdf', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = st.files.length === 0; }
    });
  }

  // ============================================================ MARKDOWN TO PDF
  if ($('#panel-md2pdf')) {
    const st = { file: null };
    setupDropzone('md2pdf', async ([f]) => {
      st.file = f;
      $('#picked-md2pdf').textContent = `File selected: ${f.name} (${fmtBytes(f.size)})`;
      setStatus('md2pdf', 'Reading file…');
      const text = await f.text();
      $('#text-md2pdf').value = text;
      setStatus('md2pdf', '');
    });
    $('#btn-md2pdf').addEventListener('click', async () => {
      const btn = $('#btn-md2pdf'); btn.disabled = true; hideResult('md2pdf');
      try {
        const markdown = $('#text-md2pdf').value.trim();
        if (!markdown) throw new Error('Markdown text box is empty.');
        setStatus('md2pdf', 'Parsing markdown text…');
        if (typeof marked === 'undefined') throw new Error('Markdown parser still loading — check your connection.');
        const html = marked.parse(markdown);
        const dom = new DOMParser().parseFromString(html, 'text/html');
        const blocks = [];
        const walk = (node, inList) => {
          for (const el of node.children) {
            const tag = el.tagName.toLowerCase();
            if (tag === 'ul' || tag === 'ol') {
              walk(el, true);
            } else if (tag === 'li') {
              blocks.push({ text: `• ${el.textContent.trim()}`, size: 11, bold: false, indent: 16 });
              walk(el, true);
            } else if (/^h[1-6]$/.test(tag)) {
              const level = +tag[1];
              blocks.push({ text: el.textContent.trim(), size: [22, 17, 14.5, 13, 12, 11][level - 1], bold: true, indent: 0 });
            } else if (tag === 'p' || tag === 'div' || tag === 'blockquote') {
              const t = el.textContent.trim();
              if (t) blocks.push({ text: t, size: 11, bold: false, indent: inList ? 16 : 0 });
            }
          }
        };
        walk(dom.body, false);
        if (!blocks.length) throw new Error('No readable markdown headings or paragraphs found.');
        setStatus('md2pdf', 'Generating PDF pages…');
        const doc = await PDFDocument.create();
        const needsUnicode = blocks.some((b) => hasThai(b.text));
        const fontReg = needsUnicode ? await getUnicodeFont(doc) : await doc.embedFont(StandardFonts.Helvetica);
        const fontBold = needsUnicode ? fontReg : await doc.embedFont(StandardFonts.HelveticaBold);
        const PAGE_W = 595.28, PAGE_H = 841.89;
        const MARGIN = +$('#margins-md2pdf').value || 56;
        const baseFontSize = +$('#size-md2pdf').value || 11.5;
        let page = doc.addPage([PAGE_W, PAGE_H]);
        let y = PAGE_H - MARGIN;
        for (const b of blocks) {
          const font = b.bold ? fontBold : fontReg;
          const size = b.bold ? b.size : baseFontSize;
          const text = needsUnicode ? b.text : toWinAnsi(b.text);
          const maxW = PAGE_W - MARGIN * 2 - b.indent;
          const lineH = size * 1.45;
          for (const line of wrapText(text, font, size, maxW)) {
            if (y < MARGIN + size) {
              page = doc.addPage([PAGE_W, PAGE_H]);
               y = PAGE_H - MARGIN;
            }
            page.drawText(line, { x: MARGIN + b.indent, y: y - size, size, font, color: rgb(0.08, 0.08, 0.12) });
            y -= lineH;
          }
          y -= size * 0.4;
        }
        const bytes = await doc.save({ useObjectStreams: true });
        showResult('md2pdf', bytes, 'document.pdf', 'application/pdf', `${doc.getPageCount()} page(s) · ${fmtBytes(bytes.length)}`);
      } catch (err) { setStatus('md2pdf', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = false; }
    });
  }

  // ============================================================ CHANGE BACKGROUND COLOR
  if ($('#dz-bgcolor')) {
    const st = { file: null, pageCount: 0 };
    setupDropzone('bgcolor', async ([f]) => {
      hideResult('bgcolor');
      try {
        setStatus('bgcolor', 'Reading PDF…');
        st.pageCount = await readPageCount(await f.arrayBuffer());
        st.file = f;
        $('#picked-bgcolor').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${st.pageCount} pages`;
        $('#btn-bgcolor').disabled = false; setStatus('bgcolor', '');
      } catch (err) {
        st.file = null; $('#btn-bgcolor').disabled = true;
        setStatus('bgcolor', `❌ ${err.message || err}`, 'error');
      }
    });
    $('#color-bgcolor').addEventListener('input', () => {
      $('#hex-bgcolor').value = $('#color-bgcolor').value;
    });
    $('#hex-bgcolor').addEventListener('input', () => {
      const hex = $('#hex-bgcolor').value;
      if (/^#[0-9a-f]{6}$/i.test(hex)) $('#color-bgcolor').value = hex;
    });
    $('#btn-bgcolor').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-bgcolor'); btn.disabled = true; hideResult('bgcolor');
      try {
        const colorHex = $('#hex-bgcolor').value.trim();
        if (!/^#[0-9a-f]{6}$/i.test(colorHex)) throw new Error('Enter a valid hex color e.g. #FEF08A.');
        const rangeStr = $('#range-bgcolor').value;
        const targets = rangeStr.trim()
          ? parseRanges(rangeStr, st.pageCount)
          : Array.from({ length: st.pageCount }, (_, i) => i + 1);
        if (!targets) throw new Error(`Enter valid pages between 1 and ${st.pageCount}.`);
        setStatus('bgcolor', 'Applying background canvas color…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const embeddedPages = await out.embedPages(src.getPages());
        const bgCol = hexToRgb(colorHex);
        for (let i = 0; i < st.pageCount; i++) {
          const srcPage = src.getPage(i);
          const { width, height } = srcPage.getSize();
          const page = out.addPage([width, height]);
          if (targets.includes(i + 1)) {
            page.drawRectangle({ x: 0, y: 0, width, height, color: bgCol });
          }
          page.drawPage(embeddedPages[i], { x: 0, y: 0, width, height });
        }
        const bytes = await out.save();
        showResult('bgcolor', bytes, `${baseName(f.name)}_colored_bg.pdf`, 'application/pdf', `Modified ${targets.length} pages`);
      } catch (err) { setStatus('bgcolor', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ PAGE DIMENSIONS
  if ($('#dz-dimensions')) {
    const st = { file: null, pageCount: 0, sizes: [] };
    setupDropzone('dimensions', async ([f]) => {
      hideResult('dimensions');
      try {
        setStatus('dimensions', 'Reading PDF page dimensions…');
        const data = await f.arrayBuffer();
        const doc = await PDFDocument.load(data.slice(0));
        st.pageCount = doc.getPageCount();
        st.sizes = [];
        const list = $('#list-dimensions');
        list.innerHTML = '';
        for (let i = 0; i < st.pageCount; i++) {
          const page = doc.getPage(i);
          const w = page.getWidth(), h = page.getHeight();
          const wMm = Math.round(w * 0.3528);
          const hMm = Math.round(h * 0.3528);
          st.sizes.push({ w, h });
          const li = document.createElement('li');
          li.textContent = `Page ${i + 1}: ${w.toFixed(1)} x ${h.toFixed(1)} pt (${wMm} x ${hMm} mm)`;
          list.appendChild(li);
        }
        st.file = f;
        $('#picked-dimensions').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${st.pageCount} pages`;
        $('#work-dimensions').classList.remove('hidden');
        $('#btn-dimensions').disabled = false;
        setStatus('dimensions', '');
      } catch (err) {
        st.file = null; $('#btn-dimensions').disabled = true;
        setStatus('dimensions', `❌ ${err.message || err}`, 'error');
      }
    });
    $('#btn-dimensions').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-dimensions'); btn.disabled = true; hideResult('dimensions');
      try {
        const SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a3: [841.89, 1190.55], a5: [419.53, 595.28] };
        const key = $('#size-dimensions').value; const [TW, TH] = SIZES[key] || SIZES.a4;
        const scaling = $('#scale-dimensions').value;
        const orient = $('#orient-dimensions').value;
        setStatus('dimensions', 'Resizing PDF page canvases…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        for (let i = 0; i < src.getPageCount(); i++) {
          const sp = src.getPage(i); const emb = await out.embedPage(sp);
          const sw = sp.getWidth(), sh = sp.getHeight();
          const [pw, ph] = orient === 'portrait' ? [TW, TH] : [TH, TW];
          const page = out.addPage([pw, ph]);
          if (scaling === 'none') {
            page.drawPage(emb, { x: 0, y: 0, width: sw, height: sh });
          } else if (scaling === 'stretch') {
            page.drawPage(emb, { x: 0, y: 0, width: pw, height: ph });
          } else {
            const scale = Math.min(pw / sw, ph / sh);
            const w = sw * scale, h = sh * scale;
            page.drawPage(emb, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
          }
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('dimensions', bytes, `${baseName(f.name)}_resized_${key}.pdf`, 'application/pdf', `Resized all pages to ${key.toUpperCase()}`);
      } catch (err) { setStatus('dimensions', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ LINK INSPECTOR
  if ($('#dz-links')) {
    const st = { file: null, links: [] };
    setupDropzone('links', async ([f]) => {
      hideResult('links');
      try {
        setStatus('links', 'Scanning for links…');
        st.file = f;
        const data = await f.arrayBuffer();
        const doc = await PDFDocument.load(data.slice(0));
        st.links = [];
        const list = $('#list-links');
        list.innerHTML = '';
        const PDFName = PDFLib.PDFName;
        const PDFArray = PDFLib.PDFArray;
        const PDFDict = PDFLib.PDFDict;
        for (let i = 0; i < doc.getPageCount(); i++) {
          const page = doc.getPage(i);
          const annots = page.node.get(PDFName.of('Annots'));
          if (annots instanceof PDFArray) {
            for (let j = 0; j < annots.size(); j++) {
              const annot = doc.context.lookup(annots.get(j));
              if (annot instanceof PDFDict && annot.get(PDFName.of('Subtype')) === PDFName.of('Link')) {
                const action = doc.context.lookup(annot.get(PDFName.of('A')));
                if (action instanceof PDFDict && action.get(PDFName.of('S')) === PDFName.of('URI')) {
                  const uriObj = action.get(PDFName.of('URI'));
                  const uri = uriObj ? uriObj.asString() : '';
                  st.links.push({ pageIndex: i, annotIndex: j, uri });
                }
              }
            }
          }
        }
        if (st.links.length === 0) {
          list.innerHTML = '<li class="text-slate-500 text-sm">No links found in this document.</li>';
          $('#btn-links').disabled = true;
        } else {
          st.links.forEach((link, idx) => {
            const li = document.createElement('li');
            li.className = 'flex flex-col sm:flex-row gap-2 items-start sm:items-center text-xs bg-white border border-slate-200 rounded-xl px-4 py-2';
            li.innerHTML = `
              <span class="font-bold text-slate-500 whitespace-nowrap">Page ${link.pageIndex + 1}:</span>
              <input type="text" data-idx="${idx}" class="link-input w-full border border-slate-300 rounded-lg px-2 py-1 font-mono" value="${escapeHtml(link.uri)}" />
              <button data-idx="${idx}" class="link-del-btn text-red-600 hover:text-red-800 ml-auto font-semibold">Remove</button>
            `;
            list.appendChild(li);
          });
          $('#btn-links').disabled = false;
        }
        $('#picked-links').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${st.links.length} link(s) found`;
        $('#work-links').classList.remove('hidden');
        setStatus('links', '');
      } catch (err) {
        setStatus('links', `❌ ${err.message || err}`, 'error');
      }
    });
    $('#list-links').addEventListener('click', (e) => {
      if (e.target.classList.contains('link-del-btn')) {
        const idx = +e.target.dataset.idx;
        const linkEl = e.target.closest('li');
        st.links[idx].deleted = true;
        linkEl.classList.add('opacity-40', 'bg-red-50');
        e.target.disabled = true;
        e.target.textContent = 'Removed';
      }
    });
    $('#btn-links').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-links'); btn.disabled = true; hideResult('links');
      try {
        setStatus('links', 'Saving updated links…');
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        const PDFName = PDFLib.PDFName;
        const PDFArray = PDFLib.PDFArray;
        const PDFDict = PDFLib.PDFDict;
        const inputs = $$('.link-input', $('#list-links'));
        inputs.forEach((inp) => {
          const idx = +inp.dataset.idx;
          st.links[idx].newUri = inp.value.trim();
        });
        const pageOps = {};
        st.links.forEach((link) => {
          if (!pageOps[link.pageIndex]) pageOps[link.pageIndex] = [];
          pageOps[link.pageIndex].push(link);
        });
        for (const pageIdx of Object.keys(pageOps).map(Number)) {
          const page = doc.getPage(pageIdx);
          const annots = page.node.get(PDFName.of('Annots'));
          if (annots instanceof PDFArray) {
            const ops = pageOps[pageIdx].sort((a, b) => b.annotIndex - a.annotIndex);
            for (const op of ops) {
              if (op.deleted) {
                annots.remove(op.annotIndex);
              } else {
                const annot = doc.context.lookup(annots.get(op.annotIndex));
                if (annot instanceof PDFDict) {
                  const action = doc.context.lookup(annot.get(PDFName.of('A')));
                  if (action instanceof PDFDict) {
                    action.set(PDFName.of('URI'), PDFLib.PDFString.of(op.newUri));
                  }
                }
              }
            }
          }
        }
        const bytes = await doc.save();
        showResult('links', bytes, `${baseName(f.name)}_updated_links.pdf`, 'application/pdf', 'Links updated successfully');
      } catch (err) { setStatus('links', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ COMPARE PDFS
  if ($('#panel-compare')) {
    const st = { fileA: null, fileB: null };
    setupDropzone('compare-a', ([f]) => {
      st.fileA = f; $('#picked-compare-a').textContent = `PDF A: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-compare').disabled = !(st.fileA && st.fileB); hideResult('compare'); setStatus('compare', '');
    });
    setupDropzone('compare-b', ([f]) => {
      st.fileB = f; $('#picked-compare-b').textContent = `PDF B: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-compare').disabled = !(st.fileA && st.fileB); hideResult('compare'); setStatus('compare', '');
    });
    $('#btn-compare').addEventListener('click', async () => {
      if (!st.fileA || !st.fileB) return; const btn = $('#btn-compare'); btn.disabled = true; hideResult('compare');
      try {
        setStatus('compare', 'Rendering pages for comparison…');
        const docA = await loadPdfJs(await st.fileA.arrayBuffer());
        const docB = await loadPdfJs(await st.fileB.arrayBuffer());
        const maxPages = Math.min(docA.numPages, docB.numPages);
        const container = $('#compare-diff-view');
        container.innerHTML = '';
        $('#res-compare').classList.remove('hidden');
        for (let i = 1; i <= maxPages; i++) {
          setStatus('compare', `Comparing page ${i} of ${maxPages}…`);
          const pageA = await docA.getPage(i);
          const pageB = await docB.getPage(i);
          const vpA = pageA.getViewport({ scale: 1.5 });
          const vpB = pageB.getViewport({ scale: 1.5 });
          const cA = document.createElement('canvas'); cA.width = vpA.width; cA.height = vpA.height;
          const cB = document.createElement('canvas'); cB.width = vpB.width; cB.height = vpB.height;
          const ctxA = cA.getContext('2d'); const ctxB = cB.getContext('2d');
          ctxA.fillStyle = '#fff'; ctxA.fillRect(0,0,vpA.width,vpA.height);
          ctxB.fillStyle = '#fff'; ctxB.fillRect(0,0,vpB.width,vpB.height);
          await pageA.render({ canvasContext: ctxA, viewport: vpA }).promise;
          await pageB.render({ canvasContext: ctxB, viewport: vpB }).promise;
          const cDiff = document.createElement('canvas');
          cDiff.width = Math.max(cA.width, cB.width);
          cDiff.height = Math.max(cA.height, cB.height);
          const ctxDiff = cDiff.getContext('2d');
          ctxDiff.fillStyle = '#fff'; ctxDiff.fillRect(0,0,cDiff.width,cDiff.height);
          const imgA = ctxA.getImageData(0, 0, cA.width, cA.height);
          const imgB = ctxB.getImageData(0, 0, cB.width, cB.height);
          const imgDiff = ctxDiff.createImageData(cDiff.width, cDiff.height);
          const dA = imgA.data; const dB = imgB.data; const dDiff = imgDiff.data;
          const len = dDiff.length;
          for (let j = 0; j < len; j += 4) {
            const rA = dA[j] !== undefined ? dA[j] : 255;
            const gA = dA[j+1] !== undefined ? dA[j+1] : 255;
            const bA = dA[j+2] !== undefined ? dA[j+2] : 255;
            const rB = dB[j] !== undefined ? dB[j] : 255;
            const gB = dB[j+1] !== undefined ? dB[j+1] : 255;
            const bB = dB[j+2] !== undefined ? dB[j+2] : 255;
            if (Math.abs(rA - rB) > 15 || Math.abs(gA - gB) > 15 || Math.abs(bA - bB) > 15) {
              dDiff[j] = 239; dDiff[j+1] = 68; dDiff[j+2] = 68; dDiff[j+3] = 255;
            } else {
              const avg = 0.5 * (rA + rB);
              dDiff[j] = avg; dDiff[j+1] = avg; dDiff[j+2] = avg; dDiff[j+3] = 60;
            }
          }
          ctxDiff.putImageData(imgDiff, 0, 0);
          const pageDiv = document.createElement('div');
          pageDiv.className = 'w-full mb-8 border border-slate-200 rounded-xl bg-white p-4';
          pageDiv.innerHTML = `
            <div class="text-xs font-bold text-slate-500 mb-2">Page ${i} Visual Difference (Changes highlighted in red):</div>
            <div class="flex flex-col md:flex-row gap-4 items-center justify-center">
              <div class="flex flex-col items-center">
                <span class="text-[10px] text-slate-400 font-semibold mb-1">Document A</span>
                <div class="border border-slate-200 rounded overflow-hidden max-w-[280px] bg-white"><img src="${cA.toDataURL()}" class="w-full" /></div>
              </div>
              <div class="flex flex-col items-center">
                <span class="text-[10px] text-slate-400 font-semibold mb-1">Document B</span>
                <div class="border border-slate-200 rounded overflow-hidden max-w-[280px] bg-white"><img src="${cB.toDataURL()}" class="w-full" /></div>
              </div>
              <div class="flex flex-col items-center">
                <span class="text-[10px] text-brand-600 font-semibold mb-1">Comparison Diff</span>
                <div class="border border-brand-200 rounded overflow-hidden max-w-[280px] bg-white"><img src="${cDiff.toDataURL()}" class="w-full" /></div>
              </div>
            </div>
          `;
          container.appendChild(pageDiv);
        }
        setStatus('compare', '✅ Done! Visual comparison generated below.', 'success');
      } catch (err) { setStatus('compare', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !(st.fileA && st.fileB); }
    });
  }

  // ============================================================ CREATE BOOKLET
  if ($('#dz-booklet')) {
    const st = { file: null, pageCount: 0 };
    setupDropzone('booklet', async ([f]) => {
      hideResult('booklet');
      try {
        setStatus('booklet', 'Reading PDF…');
        st.pageCount = await readPageCount(await f.arrayBuffer());
        st.file = f;
        $('#picked-booklet').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${st.pageCount} pages`;
        $('#btn-booklet').disabled = false; setStatus('booklet', '');
      } catch (err) {
        st.file = null; $('#btn-booklet').disabled = true;
        setStatus('booklet', `❌ ${err.message || err}`, 'error');
      }
    });
    $('#btn-booklet').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-booklet'); btn.disabled = true; hideResult('booklet');
      try {
        const bindMargin = +$('#margin-booklet').value || 0;
        setStatus('booklet', 'Imposing pages for booklet layout…');
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const out = await PDFDocument.create();
        const n = src.getPageCount();
        const targetN = Math.ceil(n / 4) * 4;
        const size = src.getPage(0).getSize();
        // Embed only real source pages; padding slots are simply left blank
        // (blank pages have no /Contents and cannot be embedded).
        const embedded = await out.embedPages(src.getPages());
        const emb = (idx) => (idx < n ? embedded[idx] : null);
        const sheetW = size.width * 2, sheetH = size.height;
        const numSheets = targetN / 4;
        for (let j = 0; j < numSheets; j++) {
          const front = out.addPage([sheetW, sheetH]);
          const eLF = emb(targetN - 1 - 2 * j), eRF = emb(2 * j);
          if (eLF) front.drawPage(eLF, { x: 0, y: 0, width: size.width, height: size.height });
          if (eRF) front.drawPage(eRF, { x: size.width + bindMargin, y: 0, width: size.width - bindMargin, height: size.height });
          const back = out.addPage([sheetW, sheetH]);
          const eLB = emb(2 * j + 1), eRB = emb(targetN - 2 - 2 * j);
          if (eLB) back.drawPage(eLB, { x: 0, y: 0, width: size.width - bindMargin, height: size.height });
          if (eRB) back.drawPage(eRB, { x: size.width, y: 0, width: size.width, height: size.height });
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult('booklet', bytes, `${baseName(f.name)}_booklet.pdf`, 'application/pdf', `${out.getPageCount()} sheets · landscape`);
      } catch (err) { setStatus('booklet', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ PDF FORM FILLER
  if ($('#dz-formfiller')) {
    const st = { file: null, fieldsInfo: [] };
    setupDropzone('formfiller', async ([f]) => {
      hideResult('formfiller');
      try {
        setStatus('formfiller', 'Scanning form fields…');
        st.file = f;
        const data = await f.arrayBuffer();
        const doc = await PDFDocument.load(data.slice(0));
        const form = doc.getForm();
        const fields = form.getFields();
        st.fieldsInfo = [];
        const formContainer = $('#form-formfiller');
        formContainer.innerHTML = '';
        if (fields.length === 0) {
          formContainer.innerHTML = '<p class="text-slate-500 text-sm">No interactive form fields found in this PDF.</p>';
          $('#btn-formfiller').disabled = true;
        } else {
          fields.forEach((field) => {
            const name = field.getName();
            const div = document.createElement('div');
            div.className = 'flex flex-col gap-1.5 text-xs';
            const label = document.createElement('label');
            label.className = 'font-semibold text-slate-700';
            label.textContent = name;
            div.appendChild(label);
            const type = field.constructor.name;
            let inputEl = null;
            if (type === 'PDFTextField' || field.constructor.name.includes('TextField')) {
              inputEl = document.createElement('input');
              inputEl.type = 'text';
              inputEl.className = 'border border-slate-300 rounded-lg px-3 py-2 w-full';
              inputEl.placeholder = 'Text value';
              inputEl.value = field.getText() || '';
            } else if (type === 'PDFCheckBox' || field.constructor.name.includes('CheckBox')) {
              inputEl = document.createElement('input');
              inputEl.type = 'checkbox';
              inputEl.checked = field.isChecked();
              inputEl.className = 'accent-brand-600 self-start';
            } else if (type === 'PDFDropdown' || field.constructor.name.includes('Dropdown')) {
              inputEl = document.createElement('select');
              inputEl.className = 'border border-slate-300 rounded-lg px-3 py-2 bg-white w-full';
              const opts = field.getOptions() || [];
              opts.forEach((opt) => {
                const o = document.createElement('option');
                o.value = opt; o.textContent = opt;
                if (field.getSelected().includes(opt)) o.selected = true;
                inputEl.appendChild(o);
              });
            } else if (type === 'PDFRadioGroup' || field.constructor.name.includes('Radio')) {
              inputEl = document.createElement('div');
              inputEl.className = 'flex gap-4';
              const opts = field.getOptions() || [];
              opts.forEach((opt) => {
                const lbl = document.createElement('label');
                lbl.className = 'flex items-center gap-1.5 cursor-pointer font-normal';
                const rad = document.createElement('input');
                rad.type = 'radio';
                rad.name = `radio-${name}`;
                rad.value = opt;
                rad.checked = field.getSelected() === opt;
                rad.className = 'accent-brand-600';
                lbl.appendChild(rad);
                lbl.appendChild(document.createTextNode(opt));
                inputEl.appendChild(lbl);
              });
            }
            if (inputEl) {
              div.appendChild(inputEl);
              formContainer.appendChild(div);
              st.fieldsInfo.push({ name, type, inputEl });
            }
          });
          $('#work-formfiller').classList.remove('hidden');
          $('#btn-formfiller').disabled = false;
        }
        $('#picked-formfiller').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${fields.length} field(s) found`;
        setStatus('formfiller', '');
      } catch (err) {
        setStatus('formfiller', `❌ ${err.message || err}`, 'error');
      }
    });
    $('#btn-formfiller').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-formfiller'); btn.disabled = true; hideResult('formfiller');
      try {
        setStatus('formfiller', 'Filling PDF form fields…');
        const doc = await loadPdfForEdit(await f.arrayBuffer());
        const form = doc.getForm();
        st.fieldsInfo.forEach((info) => {
          const field = form.getField(info.name);
          if (info.type === 'PDFTextField' || info.type.includes('TextField')) {
            field.setText(info.inputEl.value);
          } else if (info.type === 'PDFCheckBox' || info.type.includes('CheckBox')) {
            if (info.inputEl.checked) field.check(); else field.uncheck();
          } else if (info.type === 'PDFDropdown' || info.type.includes('Dropdown')) {
            field.select(info.inputEl.value);
          } else if (info.type === 'PDFRadioGroup' || info.type.includes('Radio')) {
            const checkedRad = info.inputEl.querySelector('input[type="radio"]:checked');
            if (checkedRad) field.select(checkedRad.value);
          }
        });
        const bytes = await doc.save();
        showResult('formfiller', bytes, `${baseName(f.name)}_filled.pdf`, 'application/pdf', 'Form filled successfully');
      } catch (err) { setStatus('formfiller', `❌ ${err.message || err}`, 'error'); }
      finally { btn.disabled = !st.file; }
    });
  }

  // ============================================================ PNG TO PDF
  if ($('#dz-png2pdf')) setupImageToPdfTool('png2pdf', ['png'], ['image/png']);

  // ============================================================ WEBP TO PDF
  if ($('#dz-webp2pdf')) setupImageToPdfTool('webp2pdf', ['webp'], ['image/webp']);

  // ============================================================ BMP TO PDF
  if ($('#dz-bmp2pdf')) setupImageToPdfTool('bmp2pdf', ['bmp'], ['image/bmp', 'image/x-ms-bmp']);

  // ============================================================ GIF TO PDF
  if ($('#dz-gif2pdf')) setupImageToPdfTool('gif2pdf', ['gif'], ['image/gif']);

  // ============================================================ TIFF TO PDF
  if ($('#dz-tiff2pdf')) setupImageToPdfTool('tiff2pdf', ['tiff', 'tif'], ['image/tiff', 'image/x-tiff']);

  function setupImageToPdfTool(slug, allowedExts, mimeTypes) {
    const st = { files: [] };
    const renderList = () => {
      const ul = $(`#files-${slug}`); ul.innerHTML = '';
      st.files.forEach((f, i) => {
        const li = document.createElement('li');
        li.className = 'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm';
        li.innerHTML = `<span class="font-medium truncate">${escapeHtml(f.name)}</span>
          <span class="text-slate-400 whitespace-nowrap">${fmtBytes(f.size)}</span>
          <span class="ml-auto flex gap-1">
            <button type="button" data-act="up" data-i="${i}" class="border border-slate-300 rounded-lg px-2.5 py-0.5 hover:bg-white" title="Move up">↑</button>
            <button type="button" data-act="down" data-i="${i}" class="border border-slate-300 rounded-lg px-2.5 py-0.5 hover:bg-white" title="Move down">↓</button>
            <button type="button" data-act="rm" data-i="${i}" class="border border-red-200 text-red-700 rounded-lg px-2.5 py-0.5 hover:bg-red-50" title="Remove">✕</button>
          </span>`;
        ul.appendChild(li);
      });
      $(`#btn-${slug}`).disabled = st.files.length === 0;
    };

    $(`#files-${slug}`).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const i = +btn.dataset.i;
      const act = btn.dataset.act;
      if (act === 'rm') st.files.splice(i, 1);
      if (act === 'up' && i > 0) [st.files[i - 1], st.files[i]] = [st.files[i], st.files[i - 1]];
      if (act === 'down' && i < st.files.length - 1) [st.files[i + 1], st.files[i]] = [st.files[i], st.files[i + 1]];
      renderList();
    });

    setupDropzone(slug, (files) => {
      const matched = files.filter(f => {
        const ext = f.name.split('.').pop().toLowerCase();
        return allowedExts.includes(ext) || mimeTypes.includes(f.type);
      });
      if (!matched.length) {
        setStatus(slug, `❌ Please choose files with extensions: ${allowedExts.join(', ')}`, 'error');
        return;
      }
      st.files.push(...matched);
      hideResult(slug);
      setStatus(slug, '');
      renderList();
    });

    $(`#btn-${slug}`).addEventListener('click', async () => {
      const btn = $(`#btn-${slug}`); btn.disabled = true; hideResult(slug);
      try {
        setStatus(slug, 'Converting images…');
        const mode = $(`#size-${slug}`).value;
        const A4 = [595.28, 841.89];
        const MARGIN = 36;
        const out = await PDFDocument.create();
        
        for (let i = 0; i < st.files.length; i++) {
          const f = st.files[i];
          setStatus(slug, `Processing image ${i + 1} of ${st.files.length}…`);
          const data = await f.arrayBuffer();
          
          let embeddedImage;
          const ext = f.name.split('.').pop().toLowerCase();
          if (slug === 'png2pdf') {
            embeddedImage = await out.embedPng(data);
          } else if (ext === 'tiff' || ext === 'tif') {
            // Browsers can't decode TIFF via <img>; use the UTIF decoder (lazy).
            const UTIF = await loadScriptOnce('https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js', 'UTIF');
            const ifds = UTIF.decode(data);
            UTIF.decodeImage(data, ifds[0]);
            const rgba = UTIF.toRGBA8(ifds[0]);
            const canvas = document.createElement('canvas');
            canvas.width = ifds[0].width; canvas.height = ifds[0].height;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(canvas.width, canvas.height);
            imgData.data.set(rgba);
            ctx.putImageData(imgData, 0, 0);
            const pngData = await new Promise((res) => canvas.toBlob((b) => { const r = new FileReader(); r.onloadend = () => res(r.result); r.readAsArrayBuffer(b); }, 'image/png'));
            embeddedImage = await out.embedPng(pngData);
          } else {
            const imgEl = new Image();
            const url = URL.createObjectURL(f);
            imgEl.src = url;
            await new Promise((res, rej) => {
              imgEl.onload = res;
              imgEl.onerror = rej;
            });
            URL.revokeObjectURL(url);
            
            const canvas = document.createElement('canvas');
            canvas.width = imgEl.naturalWidth || imgEl.width;
            canvas.height = imgEl.naturalHeight || imgEl.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgEl, 0, 0);
            
            const pngData = await new Promise(res => canvas.toBlob(b => {
              const reader = new FileReader();
              reader.onloadend = () => res(reader.result);
              reader.readAsArrayBuffer(b);
            }, 'image/png'));
            embeddedImage = await out.embedPng(pngData);
          }

          if (mode === 'fit') {
            const page = out.addPage([embeddedImage.width, embeddedImage.height]);
            page.drawImage(embeddedImage, { x: 0, y: 0, width: embeddedImage.width, height: embeddedImage.height });
          } else {
            const page = out.addPage(A4);
            const scale = Math.min((A4[0] - MARGIN * 2) / embeddedImage.width, (A4[1] - MARGIN * 2) / embeddedImage.height);
            const w = embeddedImage.width * scale;
            const h = embeddedImage.height * scale;
            page.drawImage(embeddedImage, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
          }
        }
        const bytes = await out.save({ useObjectStreams: true });
        showResult(slug, bytes, `${slug}_output.pdf`, 'application/pdf', `${st.files.length} images converted`);
      } catch (err) {
        setStatus(slug, `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = st.files.length === 0;
      }
    });
  }

  // ============================================================ DIVIDE PAGES
  if ($('#dz-divide')) {
    const st = { file: null, pageCount: 0 };
    const modeSelect = $('#mode-divide');
    const lblVal = $('#lbl-val-divide');
    
    modeSelect.addEventListener('change', () => {
      const mode = modeSelect.value;
      if (mode === 'single') {
        lblVal.classList.add('hidden');
      } else {
        lblVal.classList.remove('hidden');
        if (mode === 'every') {
          lblVal.innerHTML = 'Split every X pages <input type="number" id="val-divide" min="1" value="2" class="mt-1.5 w-full border border-slate-300 rounded-xl px-4 py-2.5" />';
        } else {
          lblVal.innerHTML = 'Split into N equal parts <input type="number" id="val-divide" min="1" value="2" class="mt-1.5 w-full border border-slate-300 rounded-xl px-4 py-2.5" />';
        }
      }
    });

    setupDropzone('divide', async ([f]) => {
      hideResult('divide');
      try {
        setStatus('divide', 'Reading PDF…');
        st.pageCount = await readPageCount(await f.arrayBuffer());
        st.file = f;
        $('#picked-divide').textContent = `Selected: ${f.name} (${fmtBytes(f.size)}) — ${st.pageCount} pages`;
        $('#btn-divide').disabled = false;
        setStatus('divide', '');
      } catch (err) {
        st.file = null; $('#btn-divide').disabled = true;
        setStatus('divide', `❌ ${err.message || err}`, 'error');
      }
    });

    $('#btn-divide').addEventListener('click', async () => {
      const f = st.file; if (!f) return; const btn = $('#btn-divide'); btn.disabled = true; hideResult('divide');
      try {
        setStatus('divide', 'Dividing PDF…');
        const mode = modeSelect.value;
        const val = +document.getElementById('val-divide')?.value || 1;
        const src = await loadPdfForEdit(await f.arrayBuffer());
        const total = st.pageCount;
        
        let groups = [];
        if (mode === 'single') {
          for (let i = 0; i < total; i++) groups.push([i]);
        } else if (mode === 'every') {
          if (val <= 0) throw new Error('Value must be 1 or greater.');
          for (let i = 0; i < total; i += val) {
            const grp = [];
            for (let j = i; j < i + val && j < total; j++) grp.push(j);
            groups.push(grp);
          }
        } else if (mode === 'equal') {
          if (val <= 0) throw new Error('Value must be 1 or greater.');
          const size = Math.ceil(total / val);
          for (let i = 0; i < total; i += size) {
            const grp = [];
            for (let j = i; j < i + size && j < total; j++) grp.push(j);
            groups.push(grp);
          }
        }

        if (!groups.length) throw new Error('Could not partition pages.');

        const zip = new JSZip();
        for (let idx = 0; idx < groups.length; idx++) {
          setStatus('divide', `Creating part ${idx + 1} of ${groups.length}…`);
          const out = await PDFDocument.create();
          const cop = await out.copyPages(src, groups[idx]);
          cop.forEach(p => out.addPage(p));
          const pdfBytes = await out.save({ useObjectStreams: true });
          const partName = `${baseName(f.name)}_part_${idx + 1}.pdf`;
          zip.file(partName, pdfBytes);
        }
        
        setStatus('divide', 'Generating ZIP package…');
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        showResult('divide', zipBlob, `${baseName(f.name)}_divided.zip`, 'application/zip', `${groups.length} parts created`);
      } catch (err) {
        setStatus('divide', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = !st.file;
      }
    });
  }

  // ============================================================ ADD IMAGE
  if ($('#dz-addimage')) {
    const st = { pdf: null, img: null };
    
    setupDropzone('addimage', async ([f]) => {
      st.pdf = f;
      $('#picked-addimage').textContent = `Selected PDF: ${f.name} (${fmtBytes(f.size)})`;
      checkAddImageReady();
    });

    setupDropzone('addimage-img', async ([f]) => {
      st.img = f;
      $('#picked-addimage-img').textContent = `Selected Image: ${f.name} (${fmtBytes(f.size)})`;
      checkAddImageReady();
    });

    const checkAddImageReady = () => {
      $('#btn-addimage').disabled = !(st.pdf && st.img);
    };

    $('#pos-addimage').addEventListener('change', (e) => {
      const custom = e.target.value === 'custom';
      $('#lbl-x-addimage').classList.toggle('hidden', !custom);
      $('#lbl-y-addimage').classList.toggle('hidden', !custom);
    });

    $('#btn-addimage').addEventListener('click', async () => {
      const btn = $('#btn-addimage'); btn.disabled = true; hideResult('addimage');
      try {
        setStatus('addimage', 'Loading files…');
        const docBytes = await st.pdf.arrayBuffer();
        const imgBytes = await st.img.arrayBuffer();
        
        setStatus('addimage', 'Embedding image…');
        const out = await loadPdfForEdit(docBytes);
        
        let embeddedImage;
        const isPng = st.img.type === 'image/png' || /\.png$/i.test(st.img.name);
        const isJpg = st.img.type === 'image/jpeg' || /\.jpe?g$/i.test(st.img.name);
        
        if (isPng) {
          embeddedImage = await out.embedPng(imgBytes);
        } else if (isJpg) {
          embeddedImage = await out.embedJpg(imgBytes);
        } else {
          const imgEl = new Image();
          const url = URL.createObjectURL(st.img);
          imgEl.src = url;
          await new Promise((res, rej) => {
            imgEl.onload = res;
            imgEl.onerror = rej;
          });
          URL.revokeObjectURL(url);
          const canvas = document.createElement('canvas');
          canvas.width = imgEl.naturalWidth || imgEl.width;
          canvas.height = imgEl.naturalHeight || imgEl.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(imgEl, 0, 0);
          
          const pngData = await new Promise(res => canvas.toBlob(b => {
            const r = new FileReader();
            r.onloadend = () => res(r.result);
            r.readAsArrayBuffer(b);
          }, 'image/png'));
          embeddedImage = await out.embedPng(pngData);
        }

        const scale = (+$('#scale-addimage').value || 50) / 100;
        const opacity = +$('#opacity-addimage').value || 1.0;
        const pos = $('#pos-addimage').value;
        const pageRangeStr = $('#range-addimage').value.trim();
        
        const w = embeddedImage.width * scale;
        const h = embeddedImage.height * scale;
        
        const count = out.getPageCount();
        const targets = pageRangeStr ? parseRanges(pageRangeStr, count) : Array.from({ length: count }, (_, i) => i + 1);
        if (!targets) throw new Error('Invalid page range.');

        targets.forEach(pageNum => {
          if (pageNum < 1 || pageNum > count) return;
          const page = out.getPage(pageNum - 1);
          const pageSize = page.getSize();
          
          let x = 0, y = 0;
          const margin = 20;
          if (pos === 'center') {
            x = (pageSize.width - w) / 2;
            y = (pageSize.height - h) / 2;
          } else if (pos === 'top-left') {
            x = margin;
            y = pageSize.height - h - margin;
          } else if (pos === 'top-right') {
            x = pageSize.width - w - margin;
            y = pageSize.height - h - margin;
          } else if (pos === 'bottom-left') {
            x = margin;
            y = margin;
          } else if (pos === 'bottom-right') {
            x = pageSize.width - w - margin;
            y = margin;
          } else if (pos === 'custom') {
            x = +$('#x-addimage').value || 0;
            y = +$('#y-addimage').value || 0;
          }
          
          page.drawImage(embeddedImage, { x, y, width: w, height: h, opacity });
        });

        const bytes = await out.save({ useObjectStreams: true });
        showResult('addimage', bytes, `${baseName(st.pdf.name)}_modified.pdf`, 'application/pdf', 'Image overlayed successfully');
      } catch (err) {
        setStatus('addimage', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ============================================================ EMBED FILES
  if ($('#dz-embedfile')) {
    const st = { pdf: null, attachments: [] };
    
    setupDropzone('embedfile', async ([f]) => {
      st.pdf = f;
      $('#picked-embedfile').textContent = `Selected PDF: ${f.name} (${fmtBytes(f.size)})`;
      checkEmbedReady();
    });

    setupDropzone('embedfile-att', async (files) => {
      st.attachments.push(...files);
      $('#picked-embedfile-att').textContent = `Selected ${st.attachments.length} attachment(s)`;
      checkEmbedReady();
    });

    const checkEmbedReady = () => {
      $('#btn-embedfile').disabled = !(st.pdf && st.attachments.length > 0);
    };

    $('#btn-embedfile').addEventListener('click', async () => {
      const btn = $('#btn-embedfile'); btn.disabled = true; hideResult('embedfile');
      try {
        setStatus('embedfile', 'Loading PDF…');
        const out = await loadPdfForEdit(await st.pdf.arrayBuffer());
        
        for (let i = 0; i < st.attachments.length; i++) {
          const att = st.attachments[i];
          setStatus('embedfile', `Embedding ${att.name}…`);
          const data = await att.arrayBuffer();
          await out.attach(data, att.name, {
            mimeType: att.type || 'application/octet-stream',
            description: `Embedded file: ${att.name}`
          });
        }
        
        setStatus('embedfile', 'Saving document…');
        const bytes = await out.save({ useObjectStreams: true });
        showResult('embedfile', bytes, `${baseName(st.pdf.name)}_attached.pdf`, 'application/pdf', `${st.attachments.length} attachments embedded`);
      } catch (err) {
        setStatus('embedfile', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ============================================================ EXTRACT EMBEDDED FILES
  if ($('#dz-extractfiles')) {
    const st = { file: null, attachments: [] };
    
    setupDropzone('extractfiles', async ([f]) => {
      hideResult('extractfiles');
      st.file = f;
      $('#picked-extractfiles').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-extractfiles').disabled = false;
      setStatus('extractfiles', '');
    });

    const downloadBlob = (blob, filename) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    };

    $('#btn-extractfiles').addEventListener('click', async () => {
      const btn = $('#btn-extractfiles'); btn.disabled = true; hideResult('extractfiles');
      try {
        setStatus('extractfiles', 'Scanning PDF structure for attachments…');
        const docBytes = await st.file.arrayBuffer();
        const doc = await PDFDocument.load(docBytes);
        
        const attachments = [];
        const { PDFName, PDFDict, PDFArray, PDFStream } = PDFLib;
        const catalog = doc.catalog;
        
        if (catalog.has(PDFName.of('Names'))) {
          const namesDict = catalog.lookup(PDFName.of('Names'), PDFDict);
          if (namesDict.has(PDFName.of('EmbeddedFiles'))) {
            const embeddedFilesDict = namesDict.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
            
            const processNode = (node) => {
              if (node.has(PDFName.of('Names'))) {
                const namesArray = node.lookup(PDFName.of('Names'), PDFArray);
                for (let idx = 0; idx < namesArray.size(); idx += 2) {
                  const nameStr = namesArray.get(idx).asString();
                  const fileSpec = namesArray.lookup(idx + 1, PDFDict);
                  if (fileSpec.has(PDFName.of('EF'))) {
                    const efDict = fileSpec.lookup(PDFName.of('EF'), PDFDict);
                    if (efDict.has(PDFName.of('F'))) {
                      const stream = efDict.lookup(PDFName.of('F'), PDFStream);
                      const content = stream.getContents();
                      attachments.push({ name: nameStr, bytes: content });
                    }
                  }
                }
              }
              if (node.has(PDFName.of('Kids'))) {
                const kids = node.lookup(PDFName.of('Kids'), PDFArray);
                for (let idx = 0; idx < kids.size(); idx++) {
                  processNode(kids.lookup(idx, PDFDict));
                }
              }
            };
            processNode(embeddedFilesDict);
          }
        }

        st.attachments = attachments;
        
        if (attachments.length === 0) {
          setStatus('extractfiles', 'ℹ️ No attachments or embedded files found in this PDF.');
          return;
        }

        const ul = $('#list-extractfiles'); ul.innerHTML = '';
        attachments.forEach((att, idx) => {
          const li = document.createElement('li');
          li.className = 'flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm';
          li.innerHTML = `<span class="font-medium truncate">${escapeHtml(att.name)}</span>
            <span class="text-slate-400 whitespace-nowrap">${fmtBytes(att.bytes.length)}</span>
            <button type="button" data-idx="${idx}" class="ml-auto bg-brand-600 hover:bg-brand-700 text-white font-bold px-3 py-1 rounded-lg">Download</button>`;
          ul.appendChild(li);
        });

        ul.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (b) {
            const idx = +b.dataset.idx;
            const att = st.attachments[idx];
            downloadBlob(new Blob([att.bytes]), att.name);
          }
        });

        $('#res-extractfiles').classList.remove('hidden');
        setStatus('extractfiles', `Found ${attachments.length} attachments.`);
      } catch (err) {
        setStatus('extractfiles', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('#btn-extractfiles-zip').addEventListener('click', async () => {
      if (st.attachments.length === 0) return;
      const zip = new JSZip();
      st.attachments.forEach(att => zip.file(att.name, att.bytes));
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(zipBlob, `${baseName(st.file.name)}_attachments.zip`);
    });
  }

  // ============================================================ XML TO PDF
  if ($('#btn-xml2pdf')) {
    setupDropzone('xml2pdf', async ([f]) => {
      try {
        const text = await f.text();
        $('#code-xml2pdf').value = text;
        setStatus('xml2pdf', 'XML file loaded.');
      } catch (err) {
        setStatus('xml2pdf', `❌ ${err.message || err}`, 'error');
      }
    });

    $('#btn-xml2pdf').addEventListener('click', async () => {
      const btn = $('#btn-xml2pdf'); btn.disabled = true; hideResult('xml2pdf');
      try {
        setStatus('xml2pdf', 'Parsing XML structure…');
        const xmlText = $('#code-xml2pdf').value;
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        
        const parseError = xmlDoc.getElementsByTagName('parsererror');
        if (parseError.length) throw new Error('XML parsing error: ' + parseError[0].textContent);

        setStatus('xml2pdf', 'Generating PDF report…');
        const out = await PDFDocument.create();
        out.registerFontkit(fontkit);
        
        const fontReg = await out.embedFont(StandardFonts.Helvetica);
        const fontBold = await out.embedFont(StandardFonts.HelveticaBold);
        
        const orient = $('#orient-xml2pdf').value;
        const margin = +$('#margin-xml2pdf').value || 50;
        const size = orient === 'portrait' ? [595.28, 841.89] : [841.89, 595.28];
        
        let page = out.addPage(size);
        let currY = size[1] - margin;
        const widthLimit = size[0] - margin * 2;

        const checkNewPage = (neededHeight) => {
          if (currY - neededHeight < margin) {
            page = out.addPage(size);
            currY = size[1] - margin;
          }
        };

        const wrapText = (text, fontSize, font, maxWidth) => {
          const words = text.split(/\s+/);
          const lines = [];
          let currentLine = '';
          words.forEach(w => {
            const testLine = currentLine ? `${currentLine} ${w}` : w;
            const wWidth = font.widthOfTextAtSize(testLine, fontSize);
            if (wWidth > maxWidth) {
              if (currentLine) lines.push(currentLine);
              currentLine = w;
            } else {
              currentLine = testLine;
            }
          });
          if (currentLine) lines.push(currentLine);
          return lines;
        };

        const drawParagraph = (text, sizeOpt, fontOpt, spacingOpt) => {
          const lines = wrapText(text, sizeOpt, fontOpt, widthLimit);
          lines.forEach(l => {
            checkNewPage(sizeOpt + spacingOpt);
            page.drawText(l, {
              x: margin,
              y: currY - sizeOpt,
              size: sizeOpt,
              font: fontOpt,
              color: rgb(0.1, 0.1, 0.1)
            });
            currY -= (sizeOpt + spacingOpt);
          });
        };

        const root = xmlDoc.documentElement;
        
        const processNode = (node) => {
          if (node.nodeType !== 1) return;
          const tagName = node.tagName.toLowerCase();
          
          if (tagName === 'title') {
            const text = node.textContent.trim();
            checkNewPage(40);
            const sizeTitle = 24;
            const lines = wrapText(text, sizeTitle, fontBold, widthLimit);
            lines.forEach(l => {
              page.drawText(l, {
                x: margin,
                y: currY - sizeTitle,
                size: sizeTitle,
                font: fontBold,
                color: rgb(0.1, 0.2, 0.5)
              });
              currY -= (sizeTitle + 10);
            });
            currY -= 15;
          }
          else if (tagName === 'section') {
            const title = node.getAttribute('title') || '';
            if (title) {
              checkNewPage(30);
              page.drawText(title, {
                x: margin,
                y: currY - 16,
                size: 16,
                font: fontBold,
                color: rgb(0.2, 0.2, 0.2)
              });
              currY -= 30;
            }
            Array.from(node.childNodes).forEach(processNode);
            currY -= 10;
          }
          else if (tagName === 'paragraph' || tagName === 'p') {
            const text = node.textContent.trim();
            if (text) {
              drawParagraph(text, 10, fontReg, 4);
              currY -= 8;
            }
          }
          else if (tagName === 'table') {
            const rows = node.getElementsByTagName('row');
            if (rows.length > 0) {
              checkNewPage(rows.length * 25 + 10);
              const firstRowCells = rows[0].getElementsByTagName('cell');
              const colCount = firstRowCells.length;
              const colWidth = widthLimit / colCount;
              
              Array.from(rows).forEach(row => {
                const cells = row.getElementsByTagName('cell');
                let maxCellHeight = 20;
                const cellLines = [];
                for (let c = 0; c < colCount; c++) {
                  const cell = cells[c];
                  const cText = cell ? cell.textContent.trim() : '';
                  const isHeader = cell ? (cell.getAttribute('header') === 'true') : false;
                  const font = isHeader ? fontBold : fontReg;
                  const lines = wrapText(cText, 9, font, colWidth - 8);
                  cellLines.push(lines);
                  const h = lines.length * 11 + 8;
                  if (h > maxCellHeight) maxCellHeight = h;
                }
                
                checkNewPage(maxCellHeight);
                
                for (let c = 0; c < colCount; c++) {
                  const cell = cells[c];
                  const isHeader = cell ? (cell.getAttribute('header') === 'true') : false;
                  const x = margin + c * colWidth;
                  
                  page.drawRectangle({
                    x,
                    y: currY - maxCellHeight,
                    width: colWidth,
                    height: maxCellHeight,
                    color: isHeader ? rgb(0.9, 0.9, 0.95) : rgb(0.98, 0.98, 0.98),
                    borderColor: rgb(0.8, 0.8, 0.8),
                    borderWidth: 0.5
                  });
                  
                  const lines = cellLines[c];
                  const font = isHeader ? fontBold : fontReg;
                  lines.forEach((l, lIdx) => {
                    page.drawText(l, {
                      x: x + 4,
                      y: currY - 12 - (lIdx * 11),
                      size: 9,
                      font: font,
                      color: rgb(0.1, 0.1, 0.1)
                    });
                  });
                }
                currY -= maxCellHeight;
              });
              currY -= 15;
            }
          }
          else {
            Array.from(node.childNodes).forEach(processNode);
          }
        };

        Array.from(root.childNodes).forEach(processNode);
        
        const pdfBytes = await out.save({ useObjectStreams: true });
        showResult('xml2pdf', pdfBytes, 'report.pdf', 'application/pdf', 'XML generated report successfully');
      } catch (err) {
        setStatus('xml2pdf', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ============================================================ PDF INSPECTOR
  if ($('#dz-inspect')) {
    const st = { file: null, metadata: null, overview: null, fonts: null, forms: null };
    
    const tabs = document.getElementById('inspect-tabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-tab]');
        if (!btn) return;
        const targetTab = btn.dataset.tab;
        
        tabs.querySelectorAll('button').forEach(b => {
          const isAct = b.dataset.tab === targetTab;
          b.classList.toggle('border-brand-500', isAct);
          b.classList.toggle('text-brand-600', isAct);
          b.classList.toggle('font-bold', isAct);
          b.classList.toggle('border-transparent', !isAct);
          b.classList.toggle('text-slate-500', !isAct);
        });

        $$('.inspect-tab-content').forEach(c => {
          c.classList.toggle('hidden', c.id !== `inspect-content-${targetTab}`);
        });
      });
    }

    setupDropzone('inspect', async ([f]) => {
      hideResult('inspect');
      st.file = f;
      $('#picked-inspect').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-inspect').disabled = false;
      setStatus('inspect', '');
    });

    $('#btn-inspect').addEventListener('click', async () => {
      const btn = $('#btn-inspect'); btn.disabled = true; hideResult('inspect');
      try {
        setStatus('inspect', 'Inspecting PDF document…');
        const buf = await st.file.arrayBuffer();
        
        const pdfjsDoc = await loadPdfJs(buf);
        const metadataObj = await pdfjsDoc.getMetadata();
        
        const fontSet = new Set();
        for (let i = 1; i <= pdfjsDoc.numPages; i++) {
          const page = await pdfjsDoc.getPage(i);
          const fontList = await page.commonObjs.keys();
          fontList.forEach(f => {
            if (f.startsWith('g_d')) {
              fontSet.add(f.substring(4));
            } else {
              fontSet.add(f);
            }
          });
        }
        
        const fields = [];
        const formFields = await pdfjsDoc.getFieldObjects();
        if (formFields) {
          Object.keys(formFields).forEach(k => {
            const f = formFields[k];
            fields.push({ name: k, type: f.type, value: f.value || '' });
          });
        }

        const pdfLibDoc = await PDFDocument.load(buf);
        const pages = pdfLibDoc.getPages();
        const pSize = pages[0]?.getSize();
        
        let attachmentCount = 0;
        const catalog = pdfLibDoc.catalog;
        const { PDFName, PDFDict, PDFArray } = PDFLib;
        if (catalog.has(PDFName.of('Names'))) {
          const namesDict = catalog.lookup(PDFName.of('Names'), PDFDict);
          if (namesDict.has(PDFName.of('EmbeddedFiles'))) {
            const embeddedFilesDict = namesDict.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
            const countNodes = (node) => {
              if (node.has(PDFName.of('Names'))) attachmentCount += node.lookup(PDFName.of('Names'), PDFArray).size() / 2;
              if (node.has(PDFName.of('Kids'))) {
                const kids = node.lookup(PDFName.of('Kids'), PDFArray);
                for (let idx = 0; idx < kids.size(); idx++) countNodes(kids.lookup(idx, PDFDict));
              }
            };
            countNodes(embeddedFilesDict);
          }
        }

        const overviewDiv = $('#inspect-content-overview');
        overviewDiv.innerHTML = `
          <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 grid grid-cols-2 gap-4">
            <div><span class="text-slate-500 text-xs uppercase font-semibold">Total Pages</span><div class="text-xl font-bold mt-0.5">${pdfjsDoc.numPages}</div></div>
            <div><span class="text-slate-500 text-xs uppercase font-semibold">Default Dimensions</span><div class="text-xl font-bold mt-0.5">${pSize ? `${Math.round(pSize.width)} x ${Math.round(pSize.height)} pt` : 'Unknown'}</div></div>
            <div><span class="text-slate-500 text-xs uppercase font-semibold">PDF Version</span><div class="text-xl font-bold mt-0.5">${metadataObj?.info?.PDFFormatVersion || 'Unknown'}</div></div>
            <div><span class="text-slate-500 text-xs uppercase font-semibold">Encrypted</span><div class="text-xl font-bold mt-0.5">${pdfLibDoc.isEncrypted ? '🔒 Yes' : '🔓 No'}</div></div>
            <div><span class="text-slate-500 text-xs uppercase font-semibold">Attachments Count</span><div class="text-xl font-bold mt-0.5">${attachmentCount}</div></div>
            <div><span class="text-slate-500 text-xs uppercase font-semibold">Form Fields Count</span><div class="text-xl font-bold mt-0.5">${fields.length}</div></div>
          </div>
        `;

        const metadataDiv = $('#inspect-content-metadata');
        const info = metadataObj?.info || {};
        metadataDiv.innerHTML = `
          <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col gap-2">
            <div><span class="text-slate-400 text-xs">Title</span><div class="font-medium">${escapeHtml(info.Title || 'None')}</div></div>
            <div><span class="text-slate-400 text-xs">Author</span><div class="font-medium">${escapeHtml(info.Author || 'None')}</div></div>
            <div><span class="text-slate-400 text-xs">Subject</span><div class="font-medium">${escapeHtml(info.Subject || 'None')}</div></div>
            <div><span class="text-slate-400 text-xs">Keywords</span><div class="font-medium">${escapeHtml(info.Keywords || 'None')}</div></div>
            <div><span class="text-slate-400 text-xs">Creator</span><div class="font-medium">${escapeHtml(info.Creator || 'None')}</div></div>
            <div><span class="text-slate-400 text-xs">Producer</span><div class="font-medium">${escapeHtml(info.Producer || 'None')}</div></div>
          </div>
        `;

        const fontsDiv = $('#inspect-content-fonts');
        const fontArr = Array.from(fontSet);
        if (fontArr.length > 0) {
          fontsDiv.innerHTML = `
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col gap-1.5 font-mono text-xs text-slate-800">
              ${fontArr.map(fName => `<div class="flex items-center gap-2"><span>🔤</span><span>${escapeHtml(fName)}</span></div>`).join('')}
            </div>
          `;
        } else {
          fontsDiv.innerHTML = `<div class="text-slate-500 italic p-4 text-xs">No embedded fonts found or identified.</div>`;
        }

        const formsDiv = $('#inspect-content-forms');
        if (fields.length > 0) {
          formsDiv.innerHTML = `
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col gap-2 text-xs">
              ${fields.map(f => `<div class="border-b border-slate-100 pb-1.5 last:border-b-0"><span class="text-slate-400 font-semibold">Name:</span> <span class="font-mono text-brand-700 font-semibold">${escapeHtml(f.name)}</span> &middot; <span class="text-slate-400 font-semibold">Type:</span> <span class="font-medium">${escapeHtml(f.type)}</span></div>`).join('')}
            </div>
          `;
        } else {
          formsDiv.innerHTML = `<div class="text-slate-500 italic p-4 text-xs">No interactive fields found in this PDF.</div>`;
        }

        if (tabs) {
          tabs.querySelector('button[data-tab="overview"]').dispatchEvent(new Event('click'));
        }
        
        $('#res-inspect').classList.remove('hidden');
        setStatus('inspect', '');
      } catch (err) {
        setStatus('inspect', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ============================================================ HTML TO PDF
  if ($('#btn-html2pdf')) {
    setupDropzone('html2pdf', async ([f]) => {
      try {
        const text = await f.text();
        $('#code-html2pdf').value = text;
        setStatus('html2pdf', 'HTML file loaded.');
      } catch (err) {
        setStatus('html2pdf', `❌ ${err.message || err}`, 'error');
      }
    });

    $('#btn-html2pdf').addEventListener('click', async () => {
      const btn = $('#btn-html2pdf'); btn.disabled = true; hideResult('html2pdf');
      try {
        setStatus('html2pdf', 'Rendering HTML content…');
        const htmlText = $('#code-html2pdf').value;
        const orient = $('#orient-html2pdf').value;
        const margin = +$('#margin-html2pdf').value || 30;
        
        const width = orient === 'portrait' ? 595.28 : 841.89;
        const height = orient === 'portrait' ? 841.89 : 595.28;
        
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
          <foreignObject width="100%" height="100%">
            <div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:100%;height:100%;padding:${margin}px;background:#ffffff;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,sans-serif;font-size:12px;line-height:1.5;">
              ${htmlText}
            </div>
          </foreignObject>
        </svg>`;
        
        const img = new Image();
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        img.src = url;
        
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error('Failed to render HTML content. Ensure HTML structure is valid and contains no external resources.'));
        });
        
        const canvas = document.createElement('canvas');
        const dpiScale = 2.0;
        canvas.width = Math.ceil(width * dpiScale);
        canvas.height = Math.ceil(height * dpiScale);
        
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(dpiScale, dpiScale);
        ctx.drawImage(img, 0, 0);
        
        setStatus('html2pdf', 'Generating PDF output…');
        const pngBytes = await new Promise(res => canvas.toBlob(blob => {
          const r = new FileReader();
          r.onloadend = () => res(r.result);
          r.readAsArrayBuffer(blob);
        }, 'image/png'));
        
        const out = await PDFDocument.create();
        const embedImg = await out.embedPng(pngBytes);
        const page = out.addPage([width, height]);
        page.drawImage(embedImg, { x: 0, y: 0, width, height });
        
        const pdfBytes = await out.save({ useObjectStreams: true });
        showResult('html2pdf', pdfBytes, 'html_document.pdf', 'application/pdf', 'HTML document converted successfully');
      } catch (err) {
        setStatus('html2pdf', `❌ ${err.message || err}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------ recently used tools
  // On hub pages, surface the tools this visitor used most recently (stored
  // locally on their device) for faster repeat access.
  (() => {
    const cards = document.querySelectorAll('.toolcard');
    if (!cards.length) return;
    let list = [];
    try { list = JSON.parse(localStorage.getItem('upmypdf_recent') || '[]'); } catch (_) {}
    list = list.filter((r) => r && r.url && r.name);
    if (!list.length) return;
    const firstGrid = cards[0].parentElement;
    const anchor = (firstGrid.previousElementSibling && firstGrid.previousElementSibling.tagName === 'H2') ? firstGrid.previousElementSibling : firstGrid;
    const wrap = document.createElement('div');
    wrap.className = 'mb-8';
    wrap.innerHTML = '<h2 class="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3">🕑 Recently used</h2>'
      + '<div class="flex flex-wrap gap-2">'
      + list.map((r) => `<a href="${r.url}" class="text-sm border border-slate-200 rounded-xl px-3.5 py-2 hover:bg-slate-100 font-medium text-slate-700">${(r.name || '').replace(/[<>&]/g, '')}</a>`).join('')
      + '</div>';
    anchor.parentElement.insertBefore(wrap, anchor);
  })();

  // ------------------------------------------------------ homepage tool search
  // Live-filter the tool grid on hub pages so the growing catalogue stays
  // browsable. Hides category headings whose tools are all filtered out.
  (() => {
    const cards = [...document.querySelectorAll('.toolcard')];
    if (cards.length <= 8) return;
    let input = document.getElementById('search-tools');
    let empty = document.getElementById('search-empty');
    const clearBtn = document.getElementById('search-clear');
    // Hub pages without a static search box (e.g. locale homepages): inject one.
    if (!input) {
      const firstGrid = cards[0].parentElement;
      const anchor = (firstGrid.previousElementSibling && firstGrid.previousElementSibling.tagName === 'H2') ? firstGrid.previousElementSibling : firstGrid;
      const box = document.createElement('div');
      box.className = 'max-w-2xl mx-auto relative mb-8';
      box.innerHTML = '<span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-lg">🔍</span>'
        + '<input type="search" id="search-tools" autocomplete="off" style="padding-left:2.9rem;font-size:1.05rem" class="w-full py-4 bg-white border border-slate-300 rounded-2xl shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 text-slate-900" />';
      anchor.parentElement.insertBefore(box, anchor);
      input = box.querySelector('#search-tools');
    }
    if (!empty) {
      empty = document.createElement('p');
      empty.id = 'search-empty';
      empty.className = 'hidden mt-4 text-slate-500';
      (input.closest('div') || input).insertAdjacentElement('afterend', empty);
    }
    input.setAttribute('placeholder', `Search ${cards.length} PDF tools — merge, compress, sign, convert…`);
    const grids = [...new Set(cards.map((c) => c.parentElement))];
    const apply = () => {
      const raw = input.value.trim();
      const q = raw.toLowerCase();
      let anyVisible = false;
      cards.forEach((c) => { const hit = !q || c.textContent.toLowerCase().includes(q); c.style.display = hit ? '' : 'none'; if (hit) anyVisible = true; });
      grids.forEach((g) => {
        const vis = [...g.querySelectorAll('.toolcard')].some((c) => c.style.display !== 'none');
        g.style.display = vis ? '' : 'none';
        const h = g.previousElementSibling;
        if (h && h.tagName === 'H2') h.style.display = vis ? '' : 'none';
      });
      if (clearBtn) clearBtn.classList.toggle('hidden', !raw);
      const noHits = !!raw && !anyVisible;
      empty.classList.toggle('hidden', !noHits);
      if (noHits) empty.textContent = `No tools match “${raw}”. Try “merge”, “compress”, or “convert”.`;
    };
    input.addEventListener('input', apply);
    if (clearBtn) clearBtn.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });
    // Press "/" anywhere to jump to search (unless already typing in a field).
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); input.focus(); }
    });
  })();

  // ----------------------------------------------------------------- DARK MODE
  // The prebuilt Tailwind has no dark: variants, so dark mode is a hand-written
  // override sheet injected once, toggled via a header button + localStorage.
  (() => {
    const css = `
html.dark{color-scheme:dark;}
html.dark body{background-color:#0b1220!important;color:#e2e8f0;}
html.dark .bg-slate-50{background-color:#0b1220!important;}
html.dark .bg-white{background-color:#1e293b!important;}
html.dark .bg-slate-100{background-color:#334155!important;}
html.dark header{background-color:rgba(15,23,42,.92)!important;border-color:#1e293b!important;}
html.dark footer{background-color:#0e1626!important;}
html.dark .text-slate-900{color:#f1f5f9!important;}
html.dark .text-slate-800{color:#e2e8f0!important;}
html.dark .text-slate-700{color:#cbd5e1!important;}
html.dark .text-slate-600{color:#aab6c8!important;}
html.dark .text-slate-500{color:#93a1b5!important;}
html.dark .text-slate-400{color:#7c8aa0!important;}
html.dark .border-slate-200{border-color:#283548!important;}
html.dark .border-slate-300{border-color:#3a4a61!important;}
html.dark .border-b,html.dark .border-t{border-color:#283548!important;}
html.dark input,html.dark textarea,html.dark select{background-color:#0b1220!important;color:#e2e8f0!important;border-color:#3a4a61!important;}
html.dark .dropzone{background-color:#0b1220!important;border-color:#475569!important;}
html.dark .dropzone:hover{background-color:#162234!important;}
html.dark .toolcard:hover{background-color:#243044!important;border-color:#3b82f6!important;}
html.dark .shadow-sm,html.dark .shadow{box-shadow:0 1px 3px rgba(0,0,0,.45)!important;}
html.dark .bg-emerald-50{background-color:#0d3b2e!important;}
html.dark .text-emerald-700,html.dark .text-emerald-800{color:#6ee7b7!important;}
html.dark .border-emerald-200{border-color:#15503c!important;}
html.dark .bg-brand-50{background-color:#1e3a8a!important;}
html.dark .text-brand-700{color:#93c5fd!important;}
html.dark .faq summary{color:#e2e8f0;}`;
    const s = document.createElement('style'); s.id = 'dark-css'; s.textContent = css; document.head.appendChild(s);
    let dark;
    try { const v = localStorage.getItem('upmypdf_theme'); dark = v ? v === 'dark' : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (_) { dark = false; }
    const host = document.querySelector('header .ml-auto') || document.querySelector('header > div') || document.querySelector('header');
    let btn = null;
    if (host) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'theme-toggle'; btn.setAttribute('aria-label', 'Toggle dark mode');
      btn.className = 'btn border border-slate-200 rounded-full hover:bg-slate-100';
      btn.style.cssText = 'width:2.25rem;height:2.25rem;display:inline-flex;align-items:center;justify-content:center;font-size:1.1rem;line-height:1;flex:none;';
      btn.addEventListener('click', () => { dark = !dark; try { localStorage.setItem('upmypdf_theme', dark ? 'dark' : 'light'); } catch (_) {} apply(); });
      host.insertBefore(btn, host.firstChild);
    }
    const apply = () => { document.documentElement.classList.toggle('dark', dark); if (btn) btn.textContent = dark ? '☀️' : '🌙'; };
    apply();
  })();

  // ------------------------------------------------------- report a problem
  (() => {
    const nav = document.querySelector('footer nav') || document.querySelector('footer');
    if (!nav || document.getElementById('report-link')) return;
    const a = document.createElement('a');
    a.id = 'report-link';
    a.className = 'hover:text-slate-900';
    a.href = 'mailto:skubacool@gmail.com?subject=' + encodeURIComponent('upmypdf — problem report') + '&body=' + encodeURIComponent('Page: ' + location.href + '\n\nWhat went wrong?\n');
    a.textContent = 'Report a problem';
    nav.appendChild(a);
  })();

  // ----------------------------------------------------------------- PWA
  // Register the service worker (offline + installable) and surface an
  // "Install app" button when the browser offers one — a path to repeat daily
  // use without keeping a browser tab open.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  let deferredInstall = null;
  const showInstallButton = () => {
    if (document.getElementById('pwa-install')) return;
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return;
    const b = document.createElement('button');
    b.id = 'pwa-install';
    b.type = 'button';
    b.textContent = '⤓ Install app';
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:60;background:#2563EB;color:#fff;font-weight:700;padding:10px 18px;border:0;border-radius:9999px;cursor:pointer;box-shadow:0 8px 24px rgba(37,99,235,.45);font-size:14px;';
    b.addEventListener('click', async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (_) {}
      deferredInstall = null;
      b.remove();
    });
    document.body.appendChild(b);
  };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    showInstallButton();
  });
  window.addEventListener('appinstalled', () => {
    const b = document.getElementById('pwa-install');
    if (b) b.remove();
  });
});
