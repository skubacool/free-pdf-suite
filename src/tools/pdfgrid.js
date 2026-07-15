// PDF Grid / Contact Sheet modular tool
export const initPdfGrid = () => {
  const {
    $,
    $$,
    fmtBytes,
    baseName,
    loadPdfJs,
    setupDropzone,
    showResult,
    hideResult,
    setStatus,
    PW_NEEDED_MSG
  } = window.appHelpers || {};

  if (!$) return; // Guard clause

  if ($('#dz-pdfgrid')) {
    const gridState = { file: null };
    setupDropzone('pdfgrid', ([f]) => {
      gridState.file = f;
      $('#picked-pdfgrid').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#btn-pdfgrid').disabled = false;
      hideResult('pdfgrid'); setStatus('pdfgrid', '');
    });
    $('#btn-pdfgrid').addEventListener('click', async () => {
      const f = gridState.file; if (!f) return;
      const btn = $('#btn-pdfgrid'); btn.disabled = true; hideResult('pdfgrid');
      try {
        setStatus('pdfgrid', 'Rendering pages…');
        const cols = +($('#cols-pdfgrid')?.value || 3);
        const src = await loadPdfJs(await f.arrayBuffer());
        const total = src.numPages;
        if (total > 120) {
          throw new Error('To prevent browser memory crashes, contact sheets are limited to PDFs of up to 120 pages.');
        }

        // Render all pages at a reasonable scale
        const thumbs = [];
        const thumbScale = 1.2;
        for (let i = 1; i <= total; i++) {
          setStatus('pdfgrid', `Rendering page ${i} of ${total}…`);
          const page = await src.getPage(i);
          const vp = page.getViewport({ scale: thumbScale });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width);
          c.height = Math.ceil(vp.height);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          setTimeout(() => { try { page.cleanup(); } catch(e){} }, 0);
          thumbs.push(c);
        }

        // Calculate grid layout
        const maxW = Math.max(...thumbs.map(t => t.width));
        const maxH = Math.max(...thumbs.map(t => t.height));
        const pad = 8;
        const labelH = 24;
        const cellW = maxW + pad * 2;
        const cellH = maxH + pad * 2 + labelH;
        const rows = Math.ceil(total / cols);
        const gridW = cols * cellW + pad;
        const gridH = rows * cellH + pad;

        setStatus('pdfgrid', 'Stitching grid…');
        const master = document.createElement('canvas');
        master.width = gridW;
        master.height = gridH;
        const mctx = master.getContext('2d');
        mctx.fillStyle = '#e2e8f0';
        mctx.fillRect(0, 0, gridW, gridH);

        thumbs.forEach((thumb, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const x = pad + col * cellW;
          const y = pad + row * cellH;

          // White cell background
          mctx.fillStyle = '#ffffff';
          mctx.fillRect(x, y, cellW - pad, cellH - pad);

          // Draw thumb centered in cell
          const dx = x + (cellW - pad - thumb.width) / 2;
          const dy = y + (cellH - pad - labelH - thumb.height) / 2;
          mctx.drawImage(thumb, dx, dy);

          // Page label
          mctx.fillStyle = '#475569';
          mctx.font = 'bold 14px Inter, system-ui, sans-serif';
          mctx.textAlign = 'center';
          mctx.fillText(`Page ${idx + 1}`, x + (cellW - pad) / 2, y + cellH - pad - 6);
        });

        // Export as JPEG
        const blob = await new Promise((res) => master.toBlob(res, 'image/jpeg', 0.90));
        showResult('pdfgrid', blob, `${baseName(f.name)}_grid.jpg`, 'image/jpeg',
          `${total} pages in ${cols}×${rows} grid · ${fmtBytes(blob.size)}`);
      } catch (err) {
        const PW_NEEDED_MSG = 'This PDF is password protected. Please unlock it first.';
        setStatus('pdfgrid', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
      } finally {
        btn.disabled = !gridState.file;
      }
    });
  }
};
