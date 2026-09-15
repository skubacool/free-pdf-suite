export function initHeadFoot() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib, getUnicodeFont, adjustThai } = window.appHelpers;

  const st = { file: null };
  const dz = $('#dz-headfoot');
  if (!dz) return;

  setupDropzone('headfoot', ([f]) => {
    st.file = f;
    $('#picked-headfoot').textContent = `Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
    $('#btn-headfoot').disabled = false;
  });

  $('#btn-headfoot').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    
    const headerText = $('#text-header').value.trim();
    const footerText = $('#text-footer').value.trim();
    
    if (!headerText && !footerText) {
      setStatus('headfoot', '❌ Please enter header and/or footer text.', 'error');
      return;
    }

    const btn = $('#btn-headfoot');
    btn.disabled = true;
    hideResult('headfoot');
    setStatus('headfoot', 'Processing PDF...', 'working');

    try {
      const arr = new Uint8Array(await f.arrayBuffer());
      const pdfDoc = await PDFLib.PDFDocument.load(arr, { ignoreEncryption: true });

      // Embed a Unicode font chosen for the script of the text (Thai, CJK, ...)
      const font = await getUnicodeFont(pdfDoc, headerText + footerText);

      const pages = pdfDoc.getPages();
      const totalPages = pages.length;

      for (let i = 0; i < totalPages; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        
        // Parse placeholders like {n} and {total}
        const parsedHeader = headerText.replace(/{n}/g, i + 1).replace(/{total}/g, totalPages);
        const parsedFooter = footerText.replace(/{n}/g, i + 1).replace(/{total}/g, totalPages);

        const hText = adjustThai(parsedHeader);
        const fText = adjustThai(parsedFooter);

        const fontSize = 10;
        
        if (hText) {
          const textWidth = font.widthOfTextAtSize(hText, fontSize);
          page.drawText(hText, {
            x: (width - textWidth) / 2,
            y: height - 30, // 30 points from top
            size: fontSize,
            font: font,
            color: PDFLib.rgb(0.3, 0.3, 0.3),
          });
        }
        
        if (fText) {
          const textWidth = font.widthOfTextAtSize(fText, fontSize);
          page.drawText(fText, {
            x: (width - textWidth) / 2,
            y: 30, // 30 points from bottom
            size: fontSize,
            font: font,
            color: PDFLib.rgb(0.3, 0.3, 0.3),
          });
        }
      }

      const out = await pdfDoc.save();
      showResult('headfoot', out, `${f.name.replace(/\.pdf$/i, '')}_header_footer.pdf`, 'application/pdf',
        `Processed ${totalPages} pages.`);

    } catch (e) {
      console.error(e);
      setStatus('headfoot', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
