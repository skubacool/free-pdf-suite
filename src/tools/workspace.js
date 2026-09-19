// Workspace — an Acrobat-style editor: the file is opened once and stays
// loaded; a tool rail lets the user apply any tool, in any order, as many
// times as they like. Every tool is the site's normal panel (own options, own
// button); this module feeds the working file into whichever tool is opened,
// captures its result via the shared showResult hook, makes that the new
// working file, and re-feeds it so the panel always shows the latest state.
// Undo steps back through the version history; Download always gives the
// current file. Two kinds share the code: <body data-workspace="pdf"> (the
// default) and <body data-workspace="image">.
export function initWorkspace() {
  const { $, feedTool, onResult, hideResult, setStatus, fmtBytes, baseName, PDFLib } = window.appHelpers;
  if (!$('#dz-workspace')) return;

  const KINDS = {
    pdf: {
      noun: 'document',
      accept: (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf',
      rejectMsg: '❌ Please choose a PDF file.',
      isResult: (blob) => blob.type === 'application/pdf',
      outName: (orig, result, edited) => edited ? `${baseName(orig)}_edited.pdf` : orig,
      tools: [
        { key: 'unlock',      icon: '🔓', name: 'Remove password' },
        { key: 'organize',    icon: '🗂️', name: 'Reorder pages' },
        { key: 'delete',      icon: '🗑️', name: 'Delete pages' },
        { key: 'rotate',      icon: '🔄', name: 'Rotate' },
        { key: 'crop',        icon: '✂️', name: 'Crop' },
        { key: 'removeblank', icon: '🧹', name: 'Remove blank pages' },
        { key: 'watermark',   icon: '💧', name: 'Watermark' },
        { key: 'pagenum',     icon: '🔢', name: 'Page numbers' },
        { key: 'headfoot',    icon: '📄', name: 'Header & footer' },
        { key: 'type',        icon: '⌨️', name: 'Add text' },
        { key: 'sign',        icon: '✍️', name: 'Sign' },
        { key: 'redact',      icon: '⬛', name: 'Redact' },
        { key: 'flatten',     icon: '🧊', name: 'Flatten' },
        { key: 'compress',    icon: '🗜️', name: 'Compress' },
        { key: 'protect',     icon: '🔒', name: 'Add password' },
      ],
      // page count + lock state; also decides whether other tools are blocked
      describe: async (file, st) => {
        try {
          const doc = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
          st.locked = doc.isEncrypted;
          return `${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'}${doc.isEncrypted ? ' · 🔒 password-protected' : ''}`;
        } catch (_) { return ''; }
      },
      lockMsg: '🔒 Your document is currently password-protected — use Remove password first, undo the Add password step, or download it as is.',
      unlockTool: 'unlock',
    },
    image: {
      noun: 'image',
      accept: (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name),
      rejectMsg: '❌ Please choose a JPG, PNG, WebP or HEIC image.',
      isResult: (blob) => /^image\//.test(blob.type),
      // keep the original base name but follow the tool's output extension
      // (Convert changes it); a raw tool result name like photo_resized.jpg
      // would otherwise pile suffixes up: photo_resized_rotated_...
      outName: (orig, result, edited) => {
        const ext = (result.match(/\.[a-z0-9]+$/i) || [''])[0] || (orig.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0];
        return `${baseName(orig)}${edited ? '_edited' : ''}${ext}`;
      },
      tools: [
        { key: 'imgresize',    icon: '📐', name: 'Resize' },
        { key: 'imgcrop',      icon: '✂️', name: 'Crop' },
        { key: 'imgrotate',    icon: '🔄', name: 'Rotate & flip' },
        { key: 'imground',     icon: '⭕', name: 'Circle crop' },
        { key: 'photoid',      icon: '🪪', name: 'Passport photo' },
        { key: 'imgbgremove',  icon: '🪄', name: 'Remove background' },
        { key: 'imgwatermark', icon: '💧', name: 'Watermark' },
        { key: 'imgcompress',  icon: '🗜️', name: 'Compress' },
        { key: 'imgtargetsize', icon: '🎯', name: 'Compress to size' },
        { key: 'imgconvert',   icon: '🔁', name: 'Convert format' },
      ],
      describe: async (file, st) => {
        st.locked = false;
        try {
          const bmp = await createImageBitmap(file);
          const s = `${bmp.width} × ${bmp.height} px · ${(file.type || '').replace('image/', '').toUpperCase() || 'image'}`;
          bmp.close();
          return s;
        } catch (_) { return (file.type || '').replace('image/', '').toUpperCase(); }
      },
      lockMsg: '',
      unlockTool: null,
    },
  };
  const K = KINDS[document.body.dataset.workspace || 'pdf'];
  const TOOLS = K.tools.filter((t) => $(`#panel-${t.key}`));
  const byKey = Object.fromEntries(TOOLS.map((t) => [t.key, t]));

  // history: [{ file, label }] — index 0 is the original upload
  const st = { history: [], tool: null, locked: false, thumbUrl: null };
  const cur = () => st.history[st.history.length - 1];
  const wsPanel = $('#panel-workspace');
  const rail = $('#ws-rail');
  const docBar = $('#ws-doc');
  const dz = $('#dz-workspace');
  const thumb = $('#ws-thumb');

  // ---- tool rail
  rail.innerHTML = TOOLS.map((t) => `
    <button type="button" data-ws-tool="${t.key}" class="ws-tool btn flex flex-col items-center gap-1 border border-slate-200 rounded-xl px-2 py-3 text-center hover:border-brand-600 hover:bg-brand-50/40 transition">
      <span class="text-2xl leading-none">${t.icon}</span>
      <span class="text-xs font-semibold leading-tight">${t.name}</span>
    </button>`).join('');
  rail.querySelectorAll('[data-ws-tool]').forEach((b) => b.addEventListener('click', () => openTool(b.dataset.wsTool)));

  // ---- document bar
  const renderDoc = async () => {
    const c = cur();
    if (!c) { docBar.classList.add('hidden'); dz.classList.remove('hidden'); rail.classList.add('hidden'); $('#ws-hint').classList.remove('hidden'); return; }
    dz.classList.add('hidden'); rail.classList.remove('hidden'); $('#ws-hint').classList.add('hidden');
    docBar.classList.remove('hidden');
    const meta = await K.describe(c.file, st);
    $('#ws-doc-name').textContent = c.file.name;
    $('#ws-doc-meta').textContent = `${fmtBytes(c.file.size)}${meta ? ' · ' + meta : ''}`;
    $('#ws-undo').disabled = st.history.length < 2;
    $('#ws-undo').textContent = st.history.length < 2 ? '↶ Undo' : `↶ Undo ${cur().label}`;
    $('#ws-trail').innerHTML = st.history.map((h, i) => `<span class="${i === st.history.length - 1 ? 'font-semibold text-slate-900' : ''}">${h.label}</span>`).join('<span class="mx-1.5 text-slate-300">›</span>');
    $('#ws-applied').textContent = st.history.length < 2 ? 'No edits yet — pick a tool below.' : `${st.history.length - 1} edit${st.history.length > 2 ? 's' : ''} applied · download any time`;
    if (thumb) {
      if (st.thumbUrl) URL.revokeObjectURL(st.thumbUrl);
      st.thumbUrl = null;
      if (/^image\/(jpeg|png|webp|gif|bmp)$/.test(c.file.type)) { st.thumbUrl = URL.createObjectURL(c.file); thumb.src = st.thumbUrl; thumb.classList.remove('hidden'); }
      else thumb.classList.add('hidden');
    }
  };

  // ---- open a tool with the current file loaded
  const panelsHide = () => TOOLS.forEach((t) => { const p = $(`#panel-${t.key}`); p.classList.add('hidden'); p.classList.remove('ws-step'); p.querySelector('.ws-banner')?.remove(); });
  const openTool = async (key) => {
    if (!cur()) return;
    st.tool = key;
    panelsHide();
    rail.querySelectorAll('[data-ws-tool]').forEach((b) => b.classList.toggle('ws-active', b.dataset.wsTool === key));
    const t = byKey[key];
    const panel = $(`#panel-${key}`);
    const banner = document.createElement('div');
    banner.className = 'ws-banner -mx-6 md:-mx-8 -mt-6 md:-mt-8 mb-6 px-6 md:px-8 py-3 rounded-t-2xl bg-brand-600 text-white flex flex-wrap items-center gap-3';
    banner.innerHTML = `<span class="font-bold">${t.icon} ${t.name}</span>
      <span class="text-sm text-brand-100 grow">Working on <strong class="text-white">${cur().file.name}</strong> — set the options and click the tool's button. The result is applied to your ${K.noun}.</span>
      <button type="button" class="ws-close text-sm bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 font-semibold">Close ✕</button>`;
    banner.querySelector('.ws-close').addEventListener('click', () => { panelsHide(); st.tool = null; rail.querySelectorAll('.ws-active').forEach((b) => b.classList.remove('ws-active')); wsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    panel.prepend(banner);
    panel.classList.remove('hidden');
    panel.classList.add('ws-step');
    await feed(key);
    // after feed: the tool's own select callback clears the status line
    if (st.locked && key !== K.unlockTool) setStatus(key, K.lockMsg, 'error');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const feed = async (key) => {
    try { await feedTool(key, cur().file); }
    catch (e) { setStatus(key, `❌ ${e.message || e}`, 'error'); }
  };

  // ---- a tool produced a result: it becomes the working file
  onResult(async (tool, blob, filename) => {
    if (!cur() || tool !== st.tool || !K.isResult(blob)) return;
    const t = byKey[tool];
    const name = K.outName(st.history[0].file.name, filename || '', false);
    st.history.push({ file: new File([blob], name, { type: blob.type }), label: t.name });
    await renderDoc();
    // Re-feed so the panel (and any preview) shows the updated file, and a
    // second run of the same tool chains on top of the first.
    await feed(tool);
    setStatus(tool, `✅ ${t.name} applied to your ${K.noun}. Run it again, pick another tool above, or download.`, 'success');
    flash(`✅ ${t.name} applied`);
  });
  const flash = (msg) => {
    const el = $('#ws-flash');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => el.classList.add('hidden'), 2500);
  };

  // ---- file in / actions
  window.appHelpers.setupDropzone('workspace', async ([f]) => {
    if (!K.accept(f)) { setStatus('workspace', K.rejectMsg, 'error'); return; }
    panelsHide();
    st.history = [{ file: f, label: 'Original' }];
    st.tool = null;
    setStatus('workspace', '');
    await renderDoc();
  });
  $('#ws-undo').addEventListener('click', async () => {
    if (st.history.length < 2) return;
    const undone = st.history.pop();
    await renderDoc();
    flash(`↶ ${undone.label} undone`);
    if (st.tool) { await feed(st.tool); setStatus(st.tool, `↶ ${undone.label} undone — the panel now shows the ${K.noun} as it was before.`); }
  });
  const saveBlob = (blob, name) => {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    try { if (window.gtag) gtag('event', 'tool_completed', { tool_name: 'workspace', page_path: location.pathname }); } catch (_) {}
  };
  $('#ws-download').addEventListener('click', () => {
    const c = cur(); if (!c) return;
    saveBlob(c.file, K.outName(st.history[0].file.name, c.file.name, st.history.length > 1));
  });
  // Image workspace only: wrap the current image in a one-page PDF (fits the
  // image on a page of the same aspect ratio, capped at A4 size).
  $('#ws-topdf')?.addEventListener('click', async () => {
    const c = cur(); if (!c) return;
    try {
      flash('Building PDF…');
      const bmp = await createImageBitmap(c.file);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      const keepAlpha = /png|webp/.test(c.file.type);
      if (!keepAlpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bmp, 0, 0); bmp.close();
      const bytes = await new Promise((res, rej) => canvas.toBlob((b) => (b ? b.arrayBuffer().then(res, rej) : rej(new Error('export failed'))), keepAlpha ? 'image/png' : 'image/jpeg', 0.92));
      const doc = await PDFLib.PDFDocument.create();
      const img = keepAlpha ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const maxW = 595.28, maxH = 841.89; // A4 points
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      const w = img.width * scale, h = img.height * scale;
      doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      saveBlob(new Blob([await doc.save()], { type: 'application/pdf' }), `${baseName(st.history[0].file.name)}.pdf`);
      flash('✅ PDF saved');
    } catch (e) { setStatus('workspace', `❌ Could not build the PDF: ${e.message || e}`, 'error'); }
  });
  $('#ws-new').addEventListener('click', () => {
    panelsHide();
    st.history = []; st.tool = null; st.locked = false;
    rail.querySelectorAll('.ws-active').forEach((b) => b.classList.remove('ws-active'));
    hideResult('workspace');
    renderDoc();
    wsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  renderDoc();
}
