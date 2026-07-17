export function initImageCollage() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib } = window.appHelpers;

  const st = { files: [] };
  const dz = $('#dz-imagecollage');
  if (!dz) return;

  setupDropzone('imagecollage', (files) => {
    st.files = files;
    $('#picked-imagecollage').textContent = `Selected: ${files.length} images`;
    $('#btn-imagecollage').disabled = false;
  }, true); // Allow multiple files if setupDropzone supports it. Otherwise handle manually? Wait, setupDropzone usually returns all selected files.

  $('#btn-imagecollage').addEventListener('click', async () => {
    const files = st.files;
    if (!files || files.length === 0) return;
    
    const btn = $('#btn-imagecollage');
    btn.disabled = true;
    hideResult('imagecollage');
    setStatus('imagecollage', 'Creating collage...', 'working');

    try {
      const pdfDoc = await PDFLib.PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]); // A4
      const { width, height } = page.getSize();
      
      const margin = 20;
      const spacing = 10;
      
      // Calculate grid size (e.g. 2x2 for 4 images, 3x3 for 9)
      const cols = Math.ceil(Math.sqrt(files.length));
      const rows = Math.ceil(files.length / cols);
      
      const cellWidth = (width - (margin * 2) - (spacing * (cols - 1))) / cols;
      const cellHeight = (height - (margin * 2) - (spacing * (rows - 1))) / rows;
      
      let col = 0;
      let row = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const arr = new Uint8Array(await file.arrayBuffer());
        
        let pdfImage;
        if (file.type === 'image/png') {
          pdfImage = await pdfDoc.embedPng(arr);
        } else if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
          pdfImage = await pdfDoc.embedJpg(arr);
        } else {
          continue; // Skip unsupported
        }
        
        // Scale image to fit cell while maintaining aspect ratio
        const imgDims = pdfImage.scaleToFit(cellWidth, cellHeight);
        
        const x = margin + (col * (cellWidth + spacing)) + (cellWidth - imgDims.width) / 2;
        const y = height - margin - cellHeight - (row * (cellHeight + spacing)) + (cellHeight - imgDims.height) / 2;
        
        page.drawImage(pdfImage, {
          x,
          y,
          width: imgDims.width,
          height: imgDims.height
        });
        
        col++;
        if (col >= cols) {
          col = 0;
          row++;
        }
      }

      const out = await pdfDoc.save();
      const blob = new Blob([out], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      const dlBtn = $('#dl-imagecollage');
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `Collage_${Date.now()}.pdf`;
        a.click();
      };

      $('#info-imagecollage').textContent = `Collage created with ${files.length} images.`;
      showResult('imagecollage');
      setStatus('imagecollage', '✅ Collage complete!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('imagecollage', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
