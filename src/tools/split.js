export function initSplit() {
  if (!document.getElementById('dz-split')) return;

  const { $, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfForEdit, loadPdfJs, PW_NEEDED_MSG } = window.appHelpers;
  const { PDFDocument } = window.PDFLib;

  // Local helper: parse ranges like "1-3, 5"
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

  // Local helper: fast page count that doesn't rasterize encrypted PDFs
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

  const splitState = { file: null, pageCount: 0 };

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
}
