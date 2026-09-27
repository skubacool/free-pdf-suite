export function initHighlighter() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib } = window.appHelpers;

  const st = { file: null };
  const dz = $('#dz-highlighter');
  if (!dz) return;

  // pdf.js reports only the width of a whole text run; a canvas measure of the
  // same string gives the proportions needed to place a match inside it.
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '100px Helvetica, Arial, sans-serif';
  const measure = (s) => ctx.measureText(s).width;

  setupDropzone('highlighter', ([f]) => {
    st.file = f;
    $('#picked-highlighter').textContent = `Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
    $('#btn-highlighter').disabled = false;
    hideResult('highlighter');
    setStatus('highlighter', '');
  });

  $('#btn-highlighter').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;

    const query = $('#text-query').value.trim().toLowerCase();
    if (!query) {
      setStatus('highlighter', '❌ Please enter text to highlight.', 'error');
      return;
    }

    const btn = $('#btn-highlighter');
    btn.disabled = true;
    hideResult('highlighter');
    setStatus('highlighter', 'Searching and highlighting...', 'working');

    try {
      const arr = new Uint8Array(await f.arrayBuffer());

      // pdf.js transfers the buffer it is given to its worker (leaving it
      // empty here), so hand it a copy and keep the original for pdf-lib.
      const pdfJsDoc = await window.pdfjsLib.getDocument({ data: arr.slice() }).promise;
      const pdfDoc = await PDFLib.PDFDocument.load(arr, { ignoreEncryption: true });
      const pages = pdfDoc.getPages();

      let matchCount = 0;
      const hitPages = new Set();

      for (let i = 1; i <= pdfJsDoc.numPages; i++) {
        const page = await pdfJsDoc.getPage(i);
        const textContent = await page.getTextContent();
        const pdfLibPage = pages[i - 1];

        for (const item of textContent.items) {
          const str = item.str.toLowerCase();
          if (!str) continue;
          const x = item.transform[4];
          const y = item.transform[5];
          const height = item.height || Math.hypot(item.transform[2], item.transform[3]) || 12;
          // Scale proportional sans-serif widths to the run's real width
          const scale = item.width / (measure(item.str) || 1);

          // Highlight each occurrence rather than the whole text run
          for (let at = str.indexOf(query); at !== -1; at = str.indexOf(query, at + query.length)) {
            matchCount++;
            hitPages.add(i);
            pdfLibPage.drawRectangle({
              x: x + measure(item.str.slice(0, at)) * scale,
              y: y - height * 0.2,
              width: measure(item.str.substr(at, query.length)) * scale,
              height: height * 1.2,
              color: PDFLib.rgb(1, 1, 0),
              opacity: 0.4,
            });
          }
        }
      }

      if (matchCount === 0) {
        setStatus('highlighter', '⚠️ Text not found in document. Scanned PDFs have no text layer - run OCR PDF first.', 'error');
        return;
      }

      const out = await pdfDoc.save();
      showResult('highlighter', out, `${f.name.replace(/\.pdf$/i, '')}_highlighted.pdf`, 'application/pdf',
        `Highlighted ${matchCount} match${matchCount === 1 ? '' : 'es'} on ${hitPages.size} page${hitPages.size === 1 ? '' : 's'}.`);

    } catch (e) {
      console.error(e);
      setStatus('highlighter', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
