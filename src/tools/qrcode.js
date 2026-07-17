export function initQRCode() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib } = window.appHelpers;

  const st = { file: null };
  const dz = $('#dz-qrcode');
  if (!dz) return;

  // Dynamically load qrcode generator library from CDN
  const loadQRLib = () => new Promise((resolve) => {
    if (window.QRCode) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js';
    script.onload = resolve;
    document.head.appendChild(script);
  });

  setupDropzone('qrcode', ([f]) => {
    st.file = f;
    $('#picked-qrcode').textContent = `Target PDF: ${f.name}`;
  });

  const txtInput = $('#qr-text');
  const canvas = $('#qr-canvas');
  const btn = $('#btn-qrcode');

  txtInput.addEventListener('input', async () => {
    const val = txtInput.value.trim();
    if (val.length > 0) {
      btn.disabled = false;
      await loadQRLib();
      QRCode.toCanvas(canvas, val, { margin: 1, width: 150 }, (err) => {
        if (err) console.error(err);
      });
    } else {
      btn.disabled = true;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  });

  btn.addEventListener('click', async () => {
    const text = txtInput.value.trim();
    if (!text) return;

    btn.disabled = true;
    hideResult('qrcode');
    setStatus('qrcode', 'Generating...', 'working');

    try {
      await loadQRLib();
      const qrDataUrl = await QRCode.toDataURL(text, { margin: 1, width: 200 });

      // If user provided a PDF, stamp the QR code onto the first page
      if (st.file) {
        const arr = new Uint8Array(await st.file.arrayBuffer());
        const pdfDoc = await PDFLib.PDFDocument.load(arr, { ignoreEncryption: true });
        
        const qrImage = await pdfDoc.embedPng(qrDataUrl);
        const pages = pdfDoc.getPages();
        if (pages.length > 0) {
          const page = pages[0]; // Stamp on first page
          const { width, height } = page.getSize();
          const qrDims = qrImage.scale(0.5); // scale down to 100x100
          
          // Place in top-right corner
          page.drawImage(qrImage, {
            x: width - qrDims.width - 20,
            y: height - qrDims.height - 20,
            width: qrDims.width,
            height: qrDims.height,
          });
        }
        
        const out = await pdfDoc.save();
        const blob = new Blob([out], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        
        const dlBtn = $('#dl-qrcode');
        dlBtn.textContent = '⬇️ Download Stamped PDF';
        dlBtn.onclick = () => {
          const a = document.createElement('a');
          a.href = url;
          a.download = `QR_${st.file.name}`;
          a.click();
        };
        $('#info-qrcode').textContent = 'QR Code added to the first page of the PDF.';
      } else {
        // No PDF provided, just allow downloading the QR image
        const dlBtn = $('#dl-qrcode');
        dlBtn.textContent = '⬇️ Download QR Image';
        dlBtn.onclick = () => {
          const a = document.createElement('a');
          a.href = qrDataUrl;
          a.download = 'qrcode.png';
          a.click();
        };
        $('#info-qrcode').textContent = 'QR Code generated as PNG.';
      }

      showResult('qrcode');
      setStatus('qrcode', '✅ Success!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('qrcode', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
