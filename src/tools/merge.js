export function initMerge() {
  if (!document.getElementById('dz-merge')) return;

  const { $, setupDropzone, hideResult, showResult, setStatus, fmtBytes, loadPdfForEdit } = window.appHelpers;
  const { PDFDocument } = window.PDFLib;

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
}
