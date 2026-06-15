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
  };
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
    delete results[tool];
  };

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

  // ----------------------------------------------------------- view routing
  // Two page types share this script:
  //  - The homepage hub ("/") has #home-view (card grid) + #tool-view and swaps
  //    panels in place, mirroring the active tool in the URL hash.
  //  - Dedicated static landing pages (/merge-pdf/, /sign-pdf/, ...) declare
  //    <body data-default-tool="..."> and ship without #home-view. They never
  //    write to the URL, so each route remains a clean, individually indexable
  //    document with its own immutable <head> metadata.
  const TOOLS = ['merge', 'split', 'rotate', 'compress', 'unlock', 'protect', 'sign', 'type', 'pagenum', 'watermark', 'word2pdf', 'pdf2word', 'img2pdf', 'pdf2jpg', 'delete', 'organize', 'crop', 'nup', 'ocr'];
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
          src = await PDFDocument.load(await f.arrayBuffer());
        } catch (err) {
          throw new Error(`"${f.name}" could not be read${/encrypt/i.test(String(err)) ? ' — it is password-protected. Unlock it first.' : '.'}`);
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
      const doc = await PDFDocument.load(await signState.file.arrayBuffer());
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
      const doc = await PDFDocument.load(await typeState.file.arrayBuffer());
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
      const doc = await PDFDocument.load(await f.arrayBuffer());
      splitState.file = f;
      splitState.pageCount = doc.getPageCount();
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
      const src = await PDFDocument.load(await f.arrayBuffer());
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
      const doc = await PDFDocument.load(await f.arrayBuffer());
      rotateState.file = f;
      rotateState.pageCount = doc.getPageCount();
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
      const doc = await PDFDocument.load(await f.arrayBuffer());
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
      const doc = await PDFDocument.load(await f.arrayBuffer());
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
      const doc = await PDFDocument.load(await f.arrayBuffer());
      const thai = hasThai(raw);
      const font = thai ? await getUnicodeFont(doc) : await doc.embedFont(StandardFonts.HelveticaBold);
      const text = thai ? raw : toWinAnsi(raw);
      const opacity = +$('#opacity-watermark').value / 100;
      const cos45 = Math.cos(Math.PI / 4);
      for (const page of doc.getPages()) {
        const { width: pw, height: ph } = page.getSize();
        const diag = Math.sqrt(pw * pw + ph * ph);
        // size the text so it spans ~60% of the page diagonal
        let size = 60;
        size = Math.max(18, Math.min(110, (size * diag * 0.6) / font.widthOfTextAtSize(text, size)));
        const tw = font.widthOfTextAtSize(text, size);
        page.drawText(text, {
          x: pw / 2 - (tw / 2) * cos45,
          y: ph / 2 - (tw / 2) * cos45,
          size,
          font,
          color: rgb(0.55, 0.55, 0.55),
          opacity,
          rotate: degrees(45),
        });
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
        const doc = await PDFDocument.load(await f.arrayBuffer());
        delState.file = f;
        delState.pageCount = doc.getPageCount();
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
        const src = await PDFDocument.load(await f.arrayBuffer());
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
        const src = await PDFDocument.load(await f.arrayBuffer());
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
        const doc = await PDFDocument.load(await f.arrayBuffer());
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
        const src = await PDFDocument.load(await f.arrayBuffer());
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
  // Extracts text from scanned PDFs with Tesseract.js, loaded on demand.
  if ($('#dz-ocr')) {
    const ocrState = { file: null };
    let tessPromise = null;
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
    setupDropzone('ocr', ([f]) => {
      ocrState.file = f;
      $('#picked-ocr').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-ocr').disabled = false;
      hideResult('ocr');
      setStatus('ocr', '');
    });
    $('#btn-ocr').addEventListener('click', async () => {
      const f = ocrState.file;
      if (!f) return;
      const btn = $('#btn-ocr');
      btn.disabled = true;
      hideResult('ocr');
      try {
        const lang = $('#lang-ocr').value; // eng | tha | eng+tha
        setStatus('ocr', 'Loading the OCR engine (the first run downloads language data, ~10–20 MB)…');
        const Tesseract = await loadTesseract();
        const src = await loadPdfJs(await f.arrayBuffer());
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        let out = '';
        for (let i = 1; i <= src.numPages; i++) {
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale: 2 });
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          setStatus('ocr', `Reading text from page ${i} of ${src.numPages}… (this can take a few seconds per page)`);
          const { data } = await Tesseract.recognize(canvas, lang);
          out += `--- Page ${i} ---\n${(data.text || '').trim()}\n\n`;
        }
        if (!out.replace(/--- Page \d+ ---/g, '').trim()) {
          throw new Error('No readable text was found. If this is a photo-only scan, try a clearer, higher-resolution file.');
        }
        const blob = new Blob([out], { type: 'text/plain;charset=utf-8' });
        showResult('ocr', blob, `${baseName(f.name)}_text.txt`, 'text/plain',
          `${src.numPages} page${src.numPages > 1 ? 's' : ''} read · ${fmtBytes(blob.size)} of text`);
      } catch (err) {
        setStatus('ocr', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
      } finally {
        btn.disabled = !ocrState.file;
      }
    });
  }
});
