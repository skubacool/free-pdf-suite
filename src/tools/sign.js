export function initSignTool(appHelpers) {
  const {
    $, $$, setupDropzone, hideResult, setStatus, loadPdfJs, renderPreview, fmtBytes,
    PW_NEEDED_MSG, loadPdfForEdit, decodeDataUrlBytes, getRotatedOrigin, showResult,
    clickToNorm
  } = appHelpers;

  if (!$('#dz-sign')) return;

  const state = {
    file: null,
    doc: null,
    pageNum: 1,
    placement: null,
    dataUrl: null, // Holds the base64 PNG/JPG of the signature
    natW: 1,
    natH: 1,
    mode: 'draw' // 'draw', 'type', 'upload'
  };

  const pad = $('#sigpad');
  const ctx = pad.getContext('2d', { willReadFrequently: true });
  let isDrawing = false;
  let lastX = 0;
  let lastY = 0;

  // 1. Signature Modes (Tabs)
  $$('.sigmode').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const mode = e.target.dataset.sigmode;
      state.mode = mode;
      
      // Update Tab Styles
      $$('.sigmode').forEach(b => {
        if (b.dataset.sigmode === mode) {
          b.className = 'sigmode btn text-sm rounded-lg px-3.5 py-1.5 border border-brand-600 bg-brand-50 text-brand-700 font-semibold';
        } else {
          b.className = 'sigmode btn text-sm rounded-lg px-3.5 py-1.5 border border-slate-300 hover:bg-slate-100 text-slate-600 font-semibold';
        }
      });

      // Update UI Panels
      pad.classList.toggle('hidden', mode !== 'draw');
      $('#sig-type-box').classList.toggle('hidden', mode !== 'type');
      $('#sig-upload-box').classList.toggle('hidden', mode !== 'upload');
      
      syncDataUrl();
    });
  });

  // 2. Drawing Logic
  const getPos = (e) => {
    const rect = pad.getBoundingClientRect();
    const evt = e.touches ? e.touches[0] : e;
    return [evt.clientX - rect.left, evt.clientY - rect.top];
  };

  const startDraw = (e) => {
    e.preventDefault();
    isDrawing = true;
    [lastX, lastY] = getPos(e);
  };

  const draw = (e) => {
    e.preventDefault();
    if (!isDrawing) return;
    const [x, y] = getPos(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    [lastX, lastY] = [x, y];
  };

  const endDraw = () => {
    if (isDrawing) {
      isDrawing = false;
      syncDataUrl();
    }
  };

  pad.addEventListener('mousedown', startDraw);
  pad.addEventListener('mousemove', draw);
  window.addEventListener('mouseup', endDraw);
  pad.addEventListener('touchstart', startDraw, { passive: false });
  pad.addEventListener('touchmove', draw, { passive: false });
  window.addEventListener('touchend', endDraw);

  // 3. Typing Logic
  const typeText = $('#sig-type-text');
  typeText.addEventListener('input', () => {
    if (state.mode === 'type') syncDataUrl();
  });

  // 4. Upload Logic
  const uploadInput = $('#sig-upload-input');
  const uploadPreview = $('#sig-upload-preview');
  uploadInput.addEventListener('change', () => {
    const f = uploadInput.files[0];
    if (!f) return;
    if (!/image\/(png|jpeg)/.test(f.type) && !/\.(png|jpe?g)$/i.test(f.name)) {
      alert('Please choose a PNG or JPG signature image.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      uploadPreview.innerHTML = `<img src="${reader.result}" alt="Signature preview" class="max-h-20 inline-block mx-auto border rounded p-1" />`;
      uploadPreview.dataset.result = reader.result;
      if (state.mode === 'upload') syncDataUrl();
    };
    reader.readAsDataURL(f);
  });

  // 5. Syncing DataUrl from active mode
  const syncDataUrl = () => {
    if (state.mode === 'draw') {
      // Check if canvas is empty
      const d = ctx.getImageData(0, 0, pad.width, pad.height).data;
      const isEmpty = !d.some(c => c !== 0);
      state.dataUrl = isEmpty ? null : pad.toDataURL('image/png');
    } else if (state.mode === 'type') {
      const text = typeText.value.trim();
      if (!text) {
        state.dataUrl = null;
      } else {
        const tCanvas = document.createElement('canvas');
        const tCtx = tCanvas.getContext('2d');
        tCanvas.width = 500;
        tCanvas.height = 200;
        tCtx.font = "60px 'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', cursive";
        tCtx.fillStyle = '#000';
        tCtx.textAlign = 'center';
        tCtx.textBaseline = 'middle';
        tCtx.fillText(text, 250, 100);
        state.dataUrl = tCanvas.toDataURL('image/png');
      }
    } else if (state.mode === 'upload') {
      state.dataUrl = uploadPreview.dataset.result || null;
    }

    if (state.dataUrl) {
      const img = new Image();
      img.onload = () => {
        state.natW = img.naturalWidth || 1;
        state.natH = img.naturalHeight || 1;
        redrawMarker();
      };
      img.src = state.dataUrl;
    } else {
      redrawMarker();
    }
    updateReady();
  };

  // 6. Clear logic
  $('#sig-clear').addEventListener('click', () => {
    ctx.clearRect(0, 0, pad.width, pad.height);
    typeText.value = '';
    uploadInput.value = '';
    uploadPreview.innerHTML = '';
    uploadPreview.dataset.result = '';
    syncDataUrl();
  });

  // 7. Width slider
  $('#sig-width').addEventListener('input', () => {
    $('#sig-width-val').textContent = `${$('#sig-width').value}%`;
    redrawMarker();
  });

  // 8. PDF Preview & Placement
  const updateReady = () => {
    $('#btn-sign').disabled = !(state.file && state.dataUrl && state.placement);
  };

  const redrawMarker = () => {
    const wrap = $('#wrap-sign');
    if (!wrap) return;
    $$('.place-marker', wrap).forEach((m) => m.remove());
    if (!state.placement || !state.dataUrl) return;
    
    const canvas = $('#preview-sign');
    const dispW = (+$('#sig-width').value / 100) * canvas.clientWidth;
    const dispH = dispW * (state.natH / state.natW);
    
    const m = document.createElement('img');
    m.src = state.dataUrl;
    m.className = 'place-marker absolute pointer-events-none transform -translate-x-1/2 -translate-y-1/2 drop-shadow-md';
    m.style.width = `${dispW}px`;
    m.style.height = `${dispH}px`;
    m.style.left = `${state.placement.nx * 100}%`;
    m.style.top = `${state.placement.ny * 100}%`;
    wrap.appendChild(m);
  };

  setupDropzone('sign', async ([f]) => {
    try {
      state.file = f;
      state.placement = null;
      hideResult('sign');
      setStatus('sign', 'Loading preview…');
      updateReady();
      
      state.doc = await loadPdfJs(await f.arrayBuffer());
      state.pageNum = 1;
      $('#page-sign').value = 1;
      $('#page-sign').max = state.doc.numPages;
      $('#pages-sign').textContent = `/ ${state.doc.numPages}`;
      $('#picked-sign').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#work-sign').classList.remove('hidden');
      
      await renderPreview(state, '#preview-sign', '#wrap-sign');
      redrawMarker();
      setStatus('sign', 'Create your signature and click the page preview to place it.');
    } catch (err) {
      setStatus('sign', `❌ ${err?.name === 'PasswordException' ? PW_NEEDED_MSG : err.message || err}`, 'error');
    }
    updateReady();
  });

  $('#page-sign').addEventListener('change', async () => {
    if (!state.doc) return;
    state.pageNum = Math.min(Math.max(1, +$('#page-sign').value || 1), state.doc.numPages);
    $('#page-sign').value = state.pageNum;
    state.placement = null;
    updateReady();
    await renderPreview(state, '#preview-sign', '#wrap-sign');
    updateReady();
  });

  $('#preview-sign').addEventListener('click', (e) => {
    if (!state.doc) return;
    state.placement = clickToNorm(e, $('#preview-sign'));
    redrawMarker();
    updateReady();
  });

  // 9. Execute Stamping
  $('#btn-sign').addEventListener('click', async () => {
    if (!state.placement || !state.dataUrl || !state.file) return;
    const btn = $('#btn-sign');
    btn.disabled = true;
    hideResult('sign');
    try {
      setStatus('sign', 'Applying signature…');
      const doc = await loadPdfForEdit(await state.file.arrayBuffer());
      const pageIdx = Math.min(state.pageNum, doc.getPageCount()) - 1;
      const page = doc.getPage(pageIdx);
      
      const { width: pw, height: ph } = page.getSize();
      const angle = page.getRotation().angle || 0;
      const vw = (angle === 90 || angle === 270) ? ph : pw;
      const vh = (angle === 90 || angle === 270) ? pw : ph;
      
      const bytes = state.dataUrl.startsWith('data:') 
        ? decodeDataUrlBytes(state.dataUrl) 
        : await (await fetch(state.dataUrl)).arrayBuffer();
        
      const img = /^data:image\/png/i.test(state.dataUrl) 
        ? await doc.embedPng(bytes) 
        : await doc.embedJpg(bytes);
        
      const w = (vw * +$('#sig-width').value) / 100;
      const h = (w * img.height) / img.width;

      const Vx = state.placement.nx * vw;
      const Vy = state.placement.ny * vh;
      
      const pos = getRotatedOrigin(Vx, Vy, w, h, page);

      page.drawImage(img, {
        ...pos,
        width: w,
        height: h,
      });

      const pdfBytes = await doc.save({ useObjectStreams: true });
      showResult('sign', pdfBytes, state.file.name.replace(/\.[^.]+$/, '-signed.pdf'), 'application/pdf', 'Document signed successfully');
    } catch (err) {
      console.error(err);
      setStatus('sign', `❌ Error: ${err.message || err}`, 'error');
    }
    btn.disabled = false;
  });
}
