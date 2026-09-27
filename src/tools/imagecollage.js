export function initImageCollage() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib } = window.appHelpers;

  const st = { files: [] };
  const dz = $('#dz-imagecollage');
  if (!dz) return;

  setupDropzone('imagecollage', (files) => {
    st.files = files;
    $('#picked-imagecollage').textContent = `Selected: ${files.length} image${files.length === 1 ? '' : 's'}`;
    $('#btn-imagecollage').disabled = false;
    hideResult('imagecollage');
    setStatus('imagecollage', '');
  });

  // JPG/PNG embed as-is; anything else the browser can decode (WebP, GIF, BMP,
  // AVIF...) is redrawn to a canvas and embedded as PNG.
  const embed = async (pdfDoc, file) => {
    const arr = new Uint8Array(await file.arrayBuffer());
    if (file.type === 'image/png') return pdfDoc.embedPng(arr);
    if (file.type === 'image/jpeg' || file.type === 'image/jpg') return pdfDoc.embedJpg(arr);
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return pdfDoc.embedPng(new Uint8Array(await blob.arrayBuffer()));
  };

  $('#btn-imagecollage').addEventListener('click', async () => {
    const files = st.files;
    if (!files || files.length === 0) return;

    const btn = $('#btn-imagecollage');
    btn.disabled = true;
    hideResult('imagecollage');
    setStatus('imagecollage', 'Creating collage...', 'working');

    try {
      const pdfDoc = await PDFLib.PDFDocument.create();
      const images = [];
      const skipped = [];
      for (const file of files) {
        try { images.push(await embed(pdfDoc, file)); } catch (_) { skipped.push(file.name); }
      }
      if (!images.length) {
        setStatus('imagecollage', '❌ None of these images could be read (HEIC? convert it with HEIC to JPG first).', 'error');
        return;
      }

      // A4, landscape when most images are landscape (or when chosen)
      const orient = $('#orient-imagecollage')?.value || 'auto';
      const wide = images.filter((im) => im.width > im.height).length;
      const landscape = orient === 'landscape' || (orient === 'auto' && wide > images.length / 2);
      const [width, height] = landscape ? [841.89, 595.28] : [595.28, 841.89];
      const page = pdfDoc.addPage([width, height]);

      const margin = 20;
      const spacing = 10;

      // Near-square grid: 2x2 for 4 images, 3x3 for 9, ... (wider than tall on landscape)
      let cols = Math.ceil(Math.sqrt(images.length));
      let rows = Math.ceil(images.length / cols);
      if (landscape && cols < rows) [cols, rows] = [rows, cols];

      const cellWidth = (width - (margin * 2) - (spacing * (cols - 1))) / cols;
      const cellHeight = (height - (margin * 2) - (spacing * (rows - 1))) / rows;

      images.forEach((pdfImage, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        // Scale image to fit cell while maintaining aspect ratio
        const dims = pdfImage.scaleToFit(cellWidth, cellHeight);
        page.drawImage(pdfImage, {
          x: margin + (col * (cellWidth + spacing)) + (cellWidth - dims.width) / 2,
          y: height - margin - cellHeight - (row * (cellHeight + spacing)) + (cellHeight - dims.height) / 2,
          width: dims.width,
          height: dims.height,
        });
      });

      const out = await pdfDoc.save();
      showResult('imagecollage', out, `Collage_${images.length}_images.pdf`, 'application/pdf',
        `Collage of ${images.length} image${images.length === 1 ? '' : 's'} (${cols}×${rows} grid).` +
        (skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''));

    } catch (e) {
      console.error(e);
      setStatus('imagecollage', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
