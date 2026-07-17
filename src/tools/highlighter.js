export function initHighlighter() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib } = window.appHelpers;

  const st = { file: null };
  const dz = $('#dz-highlighter');
  if (!dz) return;

  setupDropzone('highlighter', ([f]) => {
    st.file = f;
    $('#picked-highlighter').textContent = `Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
    $('#btn-highlighter').disabled = false;
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
      
      // Load with pdfjs to find coordinates
      const loadingTask = window.pdfjsLib.getDocument({ data: arr });
      const pdfJsDoc = await loadingTask.promise;
      
      // Load with pdf-lib to draw
      const pdfDoc = await PDFLib.PDFDocument.load(arr, { ignoreEncryption: true });
      const pages = pdfDoc.getPages();
      
      let matchCount = 0;

      for (let i = 1; i <= pdfJsDoc.numPages; i++) {
        const page = await pdfJsDoc.getPage(i);
        const textContent = await page.getTextContent();
        
        const pdfLibPage = pages[i - 1];
        
        for (const item of textContent.items) {
          if (item.str.toLowerCase().includes(query)) {
            matchCount++;
            
            const x = item.transform[4];
            const y = item.transform[5];
            const width = item.width;
            const height = item.height || Math.sqrt(item.transform[2] * item.transform[2] + item.transform[3] * item.transform[3]) || 12;
            
            // Draw yellow highlight with blend mode (if supported) or just opacity
            pdfLibPage.drawRectangle({
              x: x,
              y: y - (height * 0.2), // Adjust baseline
              width: width,
              height: height * 1.2,
              color: PDFLib.rgb(1, 1, 0), // Yellow
              opacity: 0.4, // Semi-transparent
            });
          }
        }
      }

      if (matchCount === 0) {
        setStatus('highlighter', '⚠️ Text not found in document.', 'error');
        btn.disabled = false;
        return;
      }

      const out = await pdfDoc.save();
      const blob = new Blob([out], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      const dlBtn = $('#dl-highlighter');
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `Highlighted_${f.name}`;
        a.click();
      };

      $('#info-highlighter').textContent = `Highlighted ${matchCount} matches.`;
      showResult('highlighter');
      setStatus('highlighter', '✅ Highlighting complete!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('highlighter', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
