export function initRotate() {
  if (!document.getElementById('dz-rotate')) return;

  const { $, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfForEdit, loadPdfJs, PW_NEEDED_MSG } = window.appHelpers;
  const { PDFDocument, degrees } = window.PDFLib;

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
}
