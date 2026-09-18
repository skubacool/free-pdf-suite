// PDF Workspace — upload one PDF, tick the jobs you need, and the page walks
// you through each tool in turn. Every step is the site's normal tool panel
// (own options, own button); this module only feeds the working PDF into the
// step, captures the result via the shared showResult hook and passes it on.
// Steps run in a fixed, safe order (unlock first, protect last).
export function initWorkspace() {
  const { $, $$, feedTool, onResult, showResult, hideResult, setStatus, fmtBytes, baseName } = window.appHelpers;
  if (!$('#dz-workspace')) return;

  const STEPS = [
    { key: 'unlock',      icon: '🔓', name: 'Remove password',   desc: 'Open a protected PDF (you need its password). Pages are re-rendered as images.' },
    { key: 'organize',    icon: '🗂️', name: 'Reorder pages',     desc: 'Drag pages into a new order.' },
    { key: 'delete',      icon: '🗑️', name: 'Delete pages',      desc: 'Remove pages you don\'t need.' },
    { key: 'rotate',      icon: '🔄', name: 'Rotate',            desc: 'Turn pages 90°, 180° or 270°.' },
    { key: 'crop',        icon: '✂️', name: 'Crop margins',      desc: 'Trim white space or cut a region.' },
    { key: 'removeblank', icon: '🧹', name: 'Remove blank pages', desc: 'Auto-detect and drop empty pages.' },
    { key: 'watermark',   icon: '💧', name: 'Watermark',         desc: 'Stamp text like CONFIDENTIAL or DRAFT.' },
    { key: 'pagenum',     icon: '🔢', name: 'Page numbers',      desc: 'Add "1 of 12" style numbering.' },
    { key: 'headfoot',    icon: '📄', name: 'Header & footer',   desc: 'Company name, date, document title.' },
    { key: 'type',        icon: '⌨️', name: 'Add text',          desc: 'Type dates, names or notes onto the page.' },
    { key: 'sign',        icon: '✍️', name: 'Sign',              desc: 'Draw, type or upload a signature and place it.' },
    { key: 'redact',      icon: '⬛', name: 'Redact',            desc: 'Black out sensitive text permanently.' },
    { key: 'flatten',     icon: '🧊', name: 'Flatten',           desc: 'Lock form fields and annotations in place.' },
    { key: 'compress',    icon: '🗜️', name: 'Compress',          desc: 'Shrink the file for email or upload.' },
    { key: 'protect',     icon: '🔒', name: 'Add password',      desc: 'Encrypt the final file (always the last step).' },
  ].filter((s) => $(`#panel-${s.key}`));

  const st = { original: null, file: null, steps: [], i: 0, active: false, done: [] };
  const wsPanel = $('#panel-workspace');
  const grid = $('#ws-tasks');
  const btn = $('#btn-workspace');
  const progress = $('#ws-progress');

  // ---- task picker
  grid.innerHTML = STEPS.map((s) => `
    <label class="ws-task flex items-start gap-3 border border-slate-200 rounded-xl p-3.5 cursor-pointer hover:border-brand-600 hover:bg-brand-50/40 transition">
      <input type="checkbox" class="mt-1 w-4 h-4 accent-brand-600" data-key="${s.key}" />
      <span class="min-w-0">
        <span class="font-semibold text-sm">${s.icon} ${s.name}</span>
        <span class="block text-xs text-slate-500 mt-0.5">${s.desc}</span>
      </span>
    </label>`).join('');
  const selected = () => STEPS.filter((s) => grid.querySelector(`input[data-key="${s.key}"]`).checked);
  const refreshBtn = () => {
    const n = selected().length;
    btn.disabled = !st.file || !n || st.active;
    btn.textContent = n <= 1 ? 'Start' : `Start ${n} steps`;
    $('#ws-count').textContent = n ? `${n} step${n > 1 ? 's' : ''} selected — they run in the order shown` : 'Pick at least one task';
  };
  grid.addEventListener('change', refreshBtn);
  $$('[data-ws-preset]').forEach((b) => b.addEventListener('click', () => {
    const keys = b.dataset.wsPreset.split(',');
    grid.querySelectorAll('input[data-key]').forEach((i) => { i.checked = keys.includes(i.dataset.key); });
    refreshBtn();
  }));

  // ---- file
  window.appHelpers.setupDropzone('workspace', ([f]) => {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { setStatus('workspace', '❌ Please choose a PDF file.', 'error'); return; }
    st.original = f;
    reset(false);
    $('#picked-workspace').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    setStatus('workspace', '');
    refreshBtn();
  });

  // ---- pipeline
  const panelsHide = () => STEPS.forEach((s) => { const p = $(`#panel-${s.key}`); p.classList.add('hidden'); p.classList.remove('ws-step'); p.querySelector('.ws-banner')?.remove(); });
  const renderProgress = () => {
    progress.classList.remove('hidden');
    progress.innerHTML = '<div class="text-xs font-semibold text-slate-500 mb-2">Your steps</div><ol class="flex flex-wrap gap-2">' +
      st.steps.map((s, k) => {
        const cls = k < st.i ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : k === st.i ? 'bg-brand-50 border-brand-600 text-brand-700 font-semibold' : 'bg-white border-slate-200 text-slate-500';
        const mark = k < st.i ? (st.done[k] ? '✓ ' : '↷ ') : k === st.i ? '▶ ' : '';
        return `<li class="border rounded-lg px-3 py-1.5 text-sm ${cls}">${mark}${s.icon} ${s.name}</li>`;
      }).join('') + '</ol>';
  };
  const runStep = async () => {
    panelsHide();
    if (st.i >= st.steps.length) return finish();
    const s = st.steps[st.i];
    renderProgress();
    const panel = $(`#panel-${s.key}`);
    const banner = document.createElement('div');
    banner.className = 'ws-banner -mx-6 md:-mx-8 -mt-6 md:-mt-8 mb-6 px-6 md:px-8 py-3 rounded-t-2xl bg-brand-600 text-white flex flex-wrap items-center gap-3';
    banner.innerHTML = `<span class="font-bold">Step ${st.i + 1} of ${st.steps.length} — ${s.icon} ${s.name}</span>
      <span class="text-sm text-brand-100 grow">Your file is already loaded below. Set the options, then click the tool's button.</span>
      <button type="button" class="ws-skip text-sm bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 font-semibold">Skip this step ↷</button>`;
    banner.querySelector('.ws-skip').addEventListener('click', () => { st.done[st.i] = false; st.i++; runStep(); });
    panel.prepend(banner);
    panel.classList.remove('hidden');
    panel.classList.add('ws-step');
    try { await feedTool(s.key, st.file); }
    catch (e) { setStatus(s.key, `❌ ${e.message || e}`, 'error'); }
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  onResult((tool, blob, filename) => {
    if (!st.active || tool !== st.steps[st.i]?.key || blob.type !== 'application/pdf') return;
    st.file = new File([blob], `${baseName(st.file.name)}.pdf`, { type: 'application/pdf' });
    st.done[st.i] = true;
    const res = $(`#res-${tool}`);
    res.querySelector('.ws-next')?.remove();
    const last = st.i + 1 >= st.steps.length;
    const next = st.steps[st.i + 1];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ws-next btn bg-brand-600 hover:bg-brand-700 text-white font-bold px-7 py-3 rounded-xl';
    b.textContent = last ? '✅ Finish — get my PDF' : `Next: ${next.icon} ${next.name} →`;
    b.addEventListener('click', () => { st.i++; runStep(); });
    const dl = res.querySelector('[id^="dl-"]');
    if (dl) dl.insertAdjacentElement('afterend', b); else res.appendChild(b);
    b.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  const finish = () => {
    st.active = false;
    st.i = st.steps.length;
    renderProgress();
    const applied = st.steps.filter((_, k) => st.done[k]);
    const skipped = st.steps.filter((_, k) => !st.done[k]);
    const info = `${baseName(st.file.name)}_edited.pdf · ${fmtBytes(st.file.size)} · ${applied.length} step${applied.length === 1 ? '' : 's'} applied` +
      (skipped.length ? ` · skipped: ${skipped.map((s) => s.name).join(', ')}` : '');
    showResult('workspace', st.file, `${baseName(st.file.name)}_edited.pdf`, 'application/pdf', info);
    $('#ws-restart').classList.remove('hidden');
    wsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const reset = (clearFile = true) => {
    st.active = false; st.steps = []; st.i = 0; st.done = [];
    panelsHide();
    progress.classList.add('hidden');
    hideResult('workspace');
    $('#ws-restart').classList.add('hidden');
    // "Start over" always restarts from the ORIGINAL upload, not the last output
    st.file = clearFile ? null : st.original;
    if (clearFile) { st.original = null; $('#picked-workspace').textContent = ''; }
    refreshBtn();
  };
  btn.addEventListener('click', () => {
    if (!st.file) return;
    st.steps = selected();
    if (!st.steps.length) return;
    st.i = 0; st.done = []; st.active = true;
    hideResult('workspace');
    $('#ws-restart').classList.add('hidden');
    refreshBtn();
    runStep();
  });
  $('#ws-restart').addEventListener('click', () => { reset(false); wsPanel.scrollIntoView({ behavior: 'smooth' }); });
  refreshBtn();
}
