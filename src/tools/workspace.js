// PDF Workspace — an Acrobat-style editor: the PDF is loaded once and stays
// loaded; a tool rail lets the user apply any tool, in any order, as many
// times as they like. Every tool is the site's normal panel (own options, own
// button); this module feeds the working document into whichever tool is
// opened, captures its result via the shared showResult hook, makes that the
// new working document, and re-feeds it so the panel always shows the latest
// state. Undo steps back through the version history; Download is always
// available and always gives the current document.
export function initWorkspace() {
  const { $, $$, feedTool, onResult, hideResult, setStatus, fmtBytes, baseName, PDFLib } = window.appHelpers;
  if (!$('#dz-workspace')) return;

  const TOOLS = [
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
  ].filter((t) => $(`#panel-${t.key}`));
  const byKey = Object.fromEntries(TOOLS.map((t) => [t.key, t]));

  // history: [{ file, label }] — index 0 is the original upload
  const st = { history: [], tool: null, encrypted: false, feeding: false };
  const cur = () => st.history[st.history.length - 1];
  const wsPanel = $('#panel-workspace');
  const rail = $('#ws-rail');
  const docBar = $('#ws-doc');
  const dz = $('#dz-workspace');

  // ---- tool rail
  rail.innerHTML = TOOLS.map((t) => `
    <button type="button" data-ws-tool="${t.key}" class="ws-tool btn flex flex-col items-center gap-1 border border-slate-200 rounded-xl px-2 py-3 text-center hover:border-brand-600 hover:bg-brand-50/40 transition">
      <span class="text-2xl leading-none">${t.icon}</span>
      <span class="text-xs font-semibold leading-tight">${t.name}</span>
    </button>`).join('');
  rail.querySelectorAll('[data-ws-tool]').forEach((b) => b.addEventListener('click', () => openTool(b.dataset.wsTool)));

  // ---- document bar
  const describe = async (file) => {
    try {
      const doc = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      st.encrypted = doc.isEncrypted;
      return `${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'}${doc.isEncrypted ? ' · 🔒 password-protected' : ''}`;
    } catch (_) { return ''; }
  };
  const renderDoc = async () => {
    const c = cur();
    if (!c) { docBar.classList.add('hidden'); dz.classList.remove('hidden'); rail.classList.add('hidden'); $('#ws-hint').classList.remove('hidden'); return; }
    dz.classList.add('hidden'); rail.classList.remove('hidden'); $('#ws-hint').classList.add('hidden');
    docBar.classList.remove('hidden');
    const meta = await describe(c.file);
    $('#ws-doc-name').textContent = c.file.name;
    $('#ws-doc-meta').textContent = `${fmtBytes(c.file.size)}${meta ? ' · ' + meta : ''}`;
    $('#ws-undo').disabled = st.history.length < 2;
    $('#ws-undo').textContent = st.history.length < 2 ? '↶ Undo' : `↶ Undo ${cur().label}`;
    const trail = st.history.map((h, i) => `<span class="${i === st.history.length - 1 ? 'font-semibold text-slate-900' : ''}">${h.label}</span>`).join('<span class="mx-1.5 text-slate-300">›</span>');
    $('#ws-trail').innerHTML = trail;
    $('#ws-applied').textContent = st.history.length < 2 ? 'No edits yet — pick a tool below.' : `${st.history.length - 1} edit${st.history.length > 2 ? 's' : ''} applied · download any time`;
  };

  // ---- open a tool with the current document loaded
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
      <span class="text-sm text-brand-100 grow">Working on <strong class="text-white">${cur().file.name}</strong> — set the options and click the tool's button. The result is applied to your document.</span>
      <button type="button" class="ws-close text-sm bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 font-semibold">Close ✕</button>`;
    banner.querySelector('.ws-close').addEventListener('click', () => { panelsHide(); st.tool = null; rail.querySelectorAll('.ws-active').forEach((b) => b.classList.remove('ws-active')); wsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    panel.prepend(banner);
    panel.classList.remove('hidden');
    panel.classList.add('ws-step');
    await feed(key);
    // after feed: the tool's own select callback clears the status line
    if (st.encrypted && key !== 'unlock') {
      setStatus(key, '🔒 Your document is currently password-protected — use Remove password first, undo the Add password step, or download it as is.', 'error');
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const feed = async (key) => {
    st.feeding = true;
    try { await feedTool(key, cur().file); }
    catch (e) { setStatus(key, `❌ ${e.message || e}`, 'error'); }
    finally { st.feeding = false; }
  };

  // ---- a tool produced a PDF: it becomes the working document
  onResult(async (tool, blob) => {
    if (!cur() || tool !== st.tool || blob.type !== 'application/pdf') return;
    const t = byKey[tool];
    st.history.push({ file: new File([blob], cur().file.name, { type: 'application/pdf' }), label: t.name });
    await renderDoc();
    // Re-feed so the panel (and any page preview) shows the updated document,
    // and a second run of the same tool chains on top of the first.
    await feed(tool);
    setStatus(tool, `✅ ${t.name} applied to your document. Run it again, pick another tool above, or download.`, 'success');
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
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { setStatus('workspace', '❌ Please choose a PDF file.', 'error'); return; }
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
    if (st.tool) { await feed(st.tool); setStatus(st.tool, `↶ ${undone.label} undone — the panel now shows the document as it was before.`); }
  });
  $('#ws-download').addEventListener('click', () => {
    const c = cur(); if (!c) return;
    const a = document.createElement('a');
    const url = URL.createObjectURL(c.file);
    a.href = url;
    a.download = st.history.length > 1 ? `${baseName(c.file.name)}_edited.pdf` : c.file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    try { if (window.gtag) gtag('event', 'tool_completed', { tool_name: 'workspace', page_path: location.pathname }); } catch (_) {}
  });
  $('#ws-new').addEventListener('click', () => {
    panelsHide();
    st.history = []; st.tool = null; st.encrypted = false;
    rail.querySelectorAll('.ws-active').forEach((b) => b.classList.remove('ws-active'));
    hideResult('workspace');
    renderDoc();
    wsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  renderDoc();
}
