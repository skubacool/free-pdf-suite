export function initBookmark() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib, getUnicodeFont, adjustThai } = window.appHelpers;

  const st = { file: null };
  const dz = $('#dz-bookmark');
  if (!dz) return;

  setupDropzone('bookmark', ([f]) => {
    st.file = f;
    $('#picked-bookmark').textContent = `Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
    $('#btn-bookmark').disabled = false;
  });

  $('#btn-bookmark').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    
    const tocText = $('#text-toc').value.trim();
    if (!tocText) {
      setStatus('bookmark', '❌ Please enter Table of Contents data.', 'error');
      return;
    }

    const btn = $('#btn-bookmark');
    btn.disabled = true;
    hideResult('bookmark');
    setStatus('bookmark', 'Generating Table of Contents...', 'working');

    try {
      const arr = new Uint8Array(await f.arrayBuffer());
      const pdfDoc = await PDFLib.PDFDocument.load(arr, { ignoreEncryption: true });
      
      const fontConf = await getUnicodeFont(pdfDoc, tocText);
      const font = fontConf.font || await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
      const needsUnicode = fontConf.needsUnicode || false;

      // Parse TOC entries
      const entries = tocText.split('\n').map(line => {
        const parts = line.split(':');
        if (parts.length >= 2) {
          const pageStr = parts.shift().trim();
          const title = parts.join(':').trim();
          const pageNum = parseInt(pageStr, 10);
          if (!isNaN(pageNum)) {
            return { pageNum, title };
          }
        }
        return null;
      }).filter(e => e !== null);

      if (entries.length === 0) {
        setStatus('bookmark', '❌ Invalid format. Use "PageNum: Title" on each line.', 'error');
        btn.disabled = false;
        return;
      }

      const totalPages = pdfDoc.getPageCount();
      
      // Insert TOC page at the beginning
      const tocPage = pdfDoc.insertPage(0, [595.28, 841.89]); // A4 size
      
      let y = 780;
      const x = 50;
      const fontSize = 14;

      const titleText = needsUnicode ? adjustThai('Table of Contents') : 'Table of Contents';
      tocPage.drawText(titleText, { x, y, size: 24, font });
      y -= 40;

      for (const entry of entries) {
        if (entry.pageNum < 1 || entry.pageNum > totalPages) continue; // Skip invalid pages
        
        const lineText = `${entry.title} .................... Page ${entry.pageNum}`;
        const drawText = needsUnicode ? adjustThai(lineText) : lineText;
        
        const textWidth = font.widthOfTextAtSize(drawText, fontSize);
        
        tocPage.drawText(drawText, {
          x,
          y,
          size: fontSize,
          font,
          color: PDFLib.rgb(0, 0.3, 0.8) // Blue link color
        });

        // Add clickable link annotation
        const targetPageRef = pdfDoc.getPages()[entry.pageNum].ref; // +1 because we inserted a page at index 0, so original page N is now N
        
        const linkAnnotation = pdfDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [x, y - 2, x + textWidth, y + fontSize],
          Border: [0, 0, 0],
          A: {
            Type: 'Action',
            S: 'GoTo',
            D: [targetPageRef, 'Fit']
          }
        });
        
        if (!tocPage.node.Annots) {
          tocPage.node.set(PDFLib.PDFName.of('Annots'), pdfDoc.context.obj([]));
        }
        tocPage.node.Annots().push(linkAnnotation);

        y -= 25;
        if (y < 50) {
          // Simplification: Not handling multi-page TOC in this basic version
          break; 
        }
      }

      const out = await pdfDoc.save();
      const blob = new Blob([out], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      const dlBtn = $('#dl-bookmark');
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `TOC_${f.name}`;
        a.click();
      };

      $('#info-bookmark').textContent = `Added Table of Contents with ${entries.length} items.`;
      showResult('bookmark');
      setStatus('bookmark', '✅ TOC added successfully!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('bookmark', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
