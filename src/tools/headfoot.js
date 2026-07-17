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

      // Embed custom font to support all languages
      const fontConf = await getUnicodeFont(pdfDoc);
      const font = fontConf.font;
      const needsUnicode = fontConf.needsUnicode;

      const pages = pdfDoc.getPages();
      const totalPages = pages.length;

      for (let i = 0; i < totalPages; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        
        // Parse placeholders like {n} and {total}
        const parsedHeader = headerText.replace(/{n}/g, i + 1).replace(/{total}/g, totalPages);
        const parsedFooter = footerText.replace(/{n}/g, i + 1).replace(/{total}/g, totalPages);

        const hText = needsUnicode ? adjustThai(parsedHeader) : parsedHeader;
        const fText = needsUnicode ? adjustThai(parsedFooter) : parsedFooter;

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
      const blob = new Blob([out], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      const dlBtn = $('#dl-headfoot');
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `HeaderFooter_${f.name}`;
        a.click();
      };

      $('#info-headfoot').textContent = `Processed ${totalPages} pages.`;
      showResult('headfoot');
      setStatus('headfoot', '✅ Header & Footer added successfully!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('headfoot', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
