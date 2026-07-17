export function initBates() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib, getUnicodeFont, adjustThai } = window.appHelpers;

  const st = { files: [] };
  const dz = $('#dz-bates');
  if (!dz) return;

  setupDropzone('bates', (files) => {
    st.files = Array.from(files);
    $('#picked-bates').textContent = `Selected: ${st.files.length} files`;
    $('#btn-bates').disabled = false;
  }, true); // true = multiple files

  $('#btn-bates').addEventListener('click', async () => {
    const files = st.files;
    if (!files || files.length === 0) return;

    const prefix = $('#bates-prefix').value.trim();
    const startNumStr = $('#bates-start').value;
    const padStr = $('#bates-pad').value;
    const suffix = $('#bates-suffix').value.trim();

    let currentNum = parseInt(startNumStr, 10) || 1;
    const pad = parseInt(padStr, 10) || 6;

    const btn = $('#btn-bates');
    btn.disabled = true;
    hideResult('bates');
    setStatus('bates', 'Processing PDFs...', 'working');

    try {
      const zip = new window.JSZip();
      let totalProcessed = 0;

      for (const f of files) {
        const arr = new Uint8Array(await f.arrayBuffer());
        const pdfDoc = await PDFLib.PDFDocument.load(arr, { ignoreEncryption: true });

        const fontConf = await getUnicodeFont(pdfDoc);
        const font = fontConf.font;
        const needsUnicode = fontConf.needsUnicode;

        const pages = pdfDoc.getPages();

        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];
          const { width, height } = page.getSize();

          const numStr = currentNum.toString().padStart(pad, '0');
          const batesText = `${prefix}${numStr}${suffix}`;
          const safeText = needsUnicode ? adjustThai(batesText) : batesText;

          const fontSize = 12;
          const textWidth = font.widthOfTextAtSize(safeText, fontSize);

          page.drawText(safeText, {
            x: width - textWidth - 30, // Bottom right margin
            y: 30,
            size: fontSize,
            font: font,
            color: PDFLib.rgb(0.1, 0.1, 0.1),
          });

          currentNum++;
          totalProcessed++;
        }

        const out = await pdfDoc.save();
        zip.file(`Bates_${f.name}`, out);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);

      const dlBtn = $('#dl-bates');
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Bates_Numbered.zip';
        a.click();
      };

      $('#info-bates').textContent = `Processed ${files.length} files (${totalProcessed} pages total).`;
      showResult('bates');
      setStatus('bates', '✅ Bates numbering complete!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('bates', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
