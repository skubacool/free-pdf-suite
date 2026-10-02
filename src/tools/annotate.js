// Annotate PDF — highlight, draw freehand, add boxes / ellipses / arrows and
// pin sticky notes, then download. Marks are drawn straight into the page, so
// they show in every viewer; sticky notes are written as real PDF /Text
// annotations (with their own icon) so Acrobat, Preview and the browser PDF
// viewers all show the comment popup. The original page content stays vector.
const TOOLS = [
  ['pen', '✏️', 'Pen'],
  ['hl', '🖍️', 'Highlight'],
  ['rect', '▭', 'Box'],
  ['ell', '◯', 'Ellipse'],
  ['arrow', '➚', 'Arrow'],
  ['note', '🗒️', 'Sticky note'],
];
const COLORS = ['#FFEB3B', '#22C55E', '#EC4899', '#EF4444', '#2563EB', '#111827'];

export function initAnnotate() {
  const { $, $$, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, renderPreview, PDFLib } = window.appHelpers;
  const { PDFDocument, rgb, LineCapStyle, PDFName, PDFHexString } = PDFLib;
  if (!$('#dz-annotate')) return;

  const st = { file: null, doc: null, pageNum: 1, anns: {}, dims: {}, tool: 'pen', color: '#EF4444', width: 2, draft: null };
  const wrap = () => $('#wrap-annotate');
  const count = () => Object.values(st.anns).reduce((a, l) => a + l.length, 0);
  const updateReady = () => {
    $('#btn-annotate').disabled = !(st.file && count() > 0);
    $('#an-count').textContent = count() ? `${count()} mark${count() > 1 ? 's' : ''}` : '';
  };

  // ---- toolbar
  const bar = $('#an-tools');
  bar.innerHTML = TOOLS.map(([k, ic, nm]) => `<button type="button" data-antool="${k}" class="btn text-sm rounded-lg px-3 py-1.5 border border-slate-300" title="${nm}">${ic} ${nm}</button>`).join('');
  $('#an-swatches').innerHTML = COLORS.map((c) => `<button type="button" data-ancolor="${c}" title="${c}" class="w-7 h-7 rounded-full border-2 border-white shadow ring-1 ring-slate-300" style="background:${c}"></button>`).join('');
  const refreshBar = () => {
    $$('[data-antool]').forEach((b) => {
      const on = b.dataset.antool === st.tool;
      b.classList.toggle('bg-brand-50', on); b.classList.toggle('border-brand-600', on); b.classList.toggle('text-brand-700', on); b.classList.toggle('font-semibold', on);
    });
    $$('[data-ancolor]').forEach((b) => { b.style.outline = b.dataset.ancolor.toLowerCase() === st.color.toLowerCase() ? '2px solid #2563eb' : 'none'; b.style.outlineOffset = '2px'; });
  };
  $$('[data-antool]').forEach((b) => b.addEventListener('click', () => {
    st.tool = b.dataset.antool;
    st.color = st.tool === 'hl' || st.tool === 'note' ? '#FFEB3B' : (['#FFEB3B'].includes(st.color.toUpperCase()) ? '#EF4444' : st.color);
    closeNoteBox();
    refreshBar();
  }));
  $$('[data-ancolor]').forEach((b) => b.addEventListener('click', () => { st.color = b.dataset.ancolor; refreshBar(); }));
  $('#an-width').addEventListener('change', () => { st.width = +$('#an-width').value || 2; });
  refreshBar();

  // ---- overlay canvas that mirrors the preview
  const ov = () => $('#overlay-annotate');
  const sizeOverlay = () => {
    const c = $('#preview-annotate'), o = ov();
    o.width = c.width; o.height = c.height;
    o.style.width = c.style.width || `${c.width}px`;
  };
  const scaleOf = () => ov().width / (st.dims[st.pageNum]?.w || ov().width);
  const draw = () => {
    const o = ov(), g = o.getContext('2d');
    g.clearRect(0, 0, o.width, o.height);
    const list = [...(st.anns[st.pageNum] || [])];
    if (st.draft) list.push(st.draft);
    list.forEach((a) => paint(g, a, o.width, o.height, scaleOf()));
  };
  const paint = (g, a, W, H, k) => {
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = a.color; g.fillStyle = a.color; g.lineWidth = (a.w || 2) * k;
    if (a.t === 'pen') {
      g.beginPath();
      a.pts.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
      if (a.pts.length === 1) g.lineTo(a.pts[0][0] * W + 0.1, a.pts[0][1] * H);
      g.stroke();
    } else if (a.t === 'hl') {
      g.globalAlpha = 0.4; g.fillRect(a.x * W, a.y * H, a.w2 * W, a.h2 * H);
    } else if (a.t === 'rect') {
      g.strokeRect(a.x * W, a.y * H, a.w2 * W, a.h2 * H);
    } else if (a.t === 'ell') {
      g.beginPath(); g.ellipse((a.x + a.w2 / 2) * W, (a.y + a.h2 / 2) * H, Math.abs(a.w2 * W / 2), Math.abs(a.h2 * H / 2), 0, 0, Math.PI * 2); g.stroke();
    } else if (a.t === 'arrow') {
      const [x1, y1, x2, y2] = [a.x1 * W, a.y1 * H, a.x2 * W, a.y2 * H];
      const ang = Math.atan2(y2 - y1, x2 - x1), hd = Math.max(9, (a.w || 2) * k * 4);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2);
      g.moveTo(x2, y2); g.lineTo(x2 - hd * Math.cos(ang - 0.45), y2 - hd * Math.sin(ang - 0.45));
      g.moveTo(x2, y2); g.lineTo(x2 - hd * Math.cos(ang + 0.45), y2 - hd * Math.sin(ang + 0.45));
      g.stroke();
    } else if (a.t === 'note') {
      const s = 20 * k;
      g.fillStyle = '#FFE14D'; g.strokeStyle = '#8a6d00'; g.lineWidth = 1;
      g.fillRect(a.x * W, a.y * H, s, s); g.strokeRect(a.x * W, a.y * H, s, s);
      g.beginPath();
      [[0.2, 0.3, 0.8, 0.3], [0.2, 0.5, 0.8, 0.5], [0.2, 0.7, 0.55, 0.7]].forEach(([ax, ay, bx, by]) => { g.moveTo(a.x * W + ax * s, a.y * H + ay * s); g.lineTo(a.x * W + bx * s, a.y * H + by * s); });
      g.stroke();
    }
    g.restore();
  };

  // ---- sticky-note text popup
  let noteBox = null;
  const closeNoteBox = () => { if (noteBox) { noteBox.remove(); noteBox = null; } };
  const openNoteBox = (nx, ny) => {
    closeNoteBox();
    noteBox = document.createElement('div');
    noteBox.className = 'absolute z-10 bg-white border border-slate-300 rounded-xl shadow-lg p-2';
    noteBox.style.cssText = `left:${Math.min(nx, 0.55) * 100}%;top:${Math.min(ny + 0.03, 0.85) * 100}%;width:220px;`;
    noteBox.innerHTML = '<textarea rows="3" class="w-full border border-slate-300 rounded-lg p-2 text-sm" placeholder="Type your note…"></textarea><div class="flex gap-2 mt-1.5"><button type="button" data-ok class="btn text-xs bg-brand-600 text-white font-semibold rounded-lg px-3 py-1.5">Add note</button><button type="button" data-cancel class="btn text-xs border border-slate-300 rounded-lg px-3 py-1.5">Cancel</button></div>';
    wrap().appendChild(noteBox);
    const ta = noteBox.querySelector('textarea');
    ta.focus();
    const ok = () => {
      const text = ta.value.trim();
      if (text) { (st.anns[st.pageNum] = st.anns[st.pageNum] || []).push({ t: 'note', x: nx, y: ny, text, color: '#FFE14D' }); draw(); updateReady(); }
      closeNoteBox();
    };
    noteBox.querySelector('[data-ok]').addEventListener('click', ok);
    noteBox.querySelector('[data-cancel]').addEventListener('click', closeNoteBox);
  };

  // ---- pointer drawing
  const rel = (e) => {
    const r = ov().getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  let start = null;
  const o0 = ov();
  o0.style.touchAction = 'none';
  o0.addEventListener('pointerdown', (e) => {
    if (!st.doc) return;
    const [x, y] = rel(e);
    if (st.tool === 'note') { openNoteBox(x, y); return; }
    closeNoteBox();
    o0.setPointerCapture(e.pointerId);
    start = [x, y];
    const base = { color: st.color, w: st.tool === 'hl' ? 0 : st.width };
    st.draft = st.tool === 'pen' ? { t: 'pen', pts: [[x, y]], ...base }
      : st.tool === 'arrow' ? { t: 'arrow', x1: x, y1: y, x2: x, y2: y, ...base }
      : { t: st.tool, x, y, w2: 0, h2: 0, ...base };
    draw();
  });
  o0.addEventListener('pointermove', (e) => {
    if (!start || !st.draft) return;
    const [x, y] = rel(e), d = st.draft;
    if (d.t === 'pen') d.pts.push([x, y]);
    else if (d.t === 'arrow') { d.x2 = x; d.y2 = y; }
    else { d.x = Math.min(start[0], x); d.y = Math.min(start[1], y); d.w2 = Math.abs(x - start[0]); d.h2 = Math.abs(y - start[1]); }
    draw();
  });
  const finish = () => {
    if (!start || !st.draft) { start = null; return; }
    const d = st.draft;
    st.draft = null; start = null;
    const tiny = d.t === 'pen' ? d.pts.length < 2 : d.t === 'arrow' ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 0.01 : d.w2 < 0.004 || d.h2 < 0.004;
    if (!tiny) { (st.anns[st.pageNum] = st.anns[st.pageNum] || []).push(d); updateReady(); }
    draw();
  };
  o0.addEventListener('pointerup', finish);
  o0.addEventListener('pointercancel', finish);

  $('#an-undo').addEventListener('click', () => { (st.anns[st.pageNum] || []).pop(); draw(); updateReady(); });
  $('#an-clear').addEventListener('click', () => { st.anns[st.pageNum] = []; draw(); updateReady(); });

  const showPage = async () => {
    await renderPreview(st, '#preview-annotate', '#wrap-annotate');
    const page = await st.doc.getPage(st.pageNum);
    const v = page.getViewport({ scale: 1 });
    st.dims[st.pageNum] = { w: v.width, h: v.height };
    sizeOverlay();
    draw();
  };

  setupDropzone('annotate', async ([f]) => {
    try {
      st.file = f; st.anns = {}; st.dims = {}; st.draft = null; hideResult('annotate');
      setStatus('annotate', 'Loading preview…');
      st.doc = await loadPdfJs(await f.arrayBuffer());
      st.pageNum = 1;
      $('#page-annotate').value = 1;
      $('#page-annotate').max = st.doc.numPages;
      $('#pages-annotate').textContent = `/ ${st.doc.numPages}`;
      $('#picked-annotate').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#work-annotate').classList.remove('hidden');
      await showPage();
      setStatus('annotate', 'Pick a tool, then draw on the page.');
    } catch (err) {
      setStatus('annotate', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
    }
    updateReady();
  });
  $('#page-annotate').addEventListener('change', async () => {
    if (!st.doc) return;
    st.pageNum = Math.min(Math.max(1, +$('#page-annotate').value || 1), st.doc.numPages);
    $('#page-annotate').value = st.pageNum;
    closeNoteBox();
    await showPage();
  });

  // ---- write the marks into the PDF
  const hex = (c) => { const n = parseInt(c.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
  $('#btn-annotate').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    const btn = $('#btn-annotate');
    btn.disabled = true;
    hideResult('annotate');
    try {
      setStatus('annotate', 'Adding your marks…');
      const doc = await PDFDocument.load(await f.arrayBuffer());
      const pages = doc.getPages();
      const ctx = doc.context;
      for (const [num, list] of Object.entries(st.anns)) {
        const page = pages[num - 1];
        if (!page || !list.length) continue;
        const { width: W, height: H } = page.getSize();
        const rot = ((page.getRotation().angle % 360) + 360) % 360;
        const [Wv, Hv] = rot % 180 ? [H, W] : [W, H];
        // view (normalised, top-left origin) -> PDF user space
        const P = (nx, ny) => {
          const vx = nx * Wv, vy = ny * Hv;
          return rot === 90 ? [vy, vx] : rot === 180 ? [W - vx, vy] : rot === 270 ? [W - vy, H - vx] : [vx, H - vy];
        };
        for (const a of list) {
          const color = hex(a.color);
          if (a.t === 'pen') {
            for (let i = 1; i < a.pts.length; i++) {
              const [x1, y1] = P(...a.pts[i - 1]), [x2, y2] = P(...a.pts[i]);
              page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.w, color, lineCap: LineCapStyle.Round });
            }
          } else if (a.t === 'hl' || a.t === 'rect' || a.t === 'ell') {
            const [ax, ay] = P(a.x, a.y), [bx, by] = P(a.x + a.w2, a.y + a.h2);
            const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
            if (a.t === 'hl') page.drawRectangle({ x, y, width: w, height: h, color, opacity: 0.4 });
            else if (a.t === 'rect') page.drawRectangle({ x, y, width: w, height: h, borderColor: color, borderWidth: a.w });
            else page.drawEllipse({ x: x + w / 2, y: y + h / 2, xScale: w / 2, yScale: h / 2, borderColor: color, borderWidth: a.w });
          } else if (a.t === 'arrow') {
            const [x1, y1] = P(a.x1, a.y1), [x2, y2] = P(a.x2, a.y2);
            const ang = Math.atan2(y2 - y1, x2 - x1), hd = Math.max(7, a.w * 4);
            const seg = (sx, sy, ex, ey) => page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: a.w, color, lineCap: LineCapStyle.Round });
            seg(x1, y1, x2, y2);
            seg(x2, y2, x2 - hd * Math.cos(ang - 0.45), y2 - hd * Math.sin(ang - 0.45));
            seg(x2, y2, x2 - hd * Math.cos(ang + 0.45), y2 - hd * Math.sin(ang + 0.45));
          } else if (a.t === 'note') {
            const [nx, ny] = P(a.x, a.y);
            const S = 20;
            const x = Math.min(Math.max(nx, 0), W - S), y = Math.min(Math.max(ny - S, 0), H - S);
            const ap = ctx.register(ctx.stream(
              'q 1 0.88 0.3 rg 0 0 20 20 re f 0.54 0.43 0 RG 1 w 0.5 0.5 19 19 re S 4 14 m 16 14 l S 4 10 m 16 10 l S 4 6 m 11 6 l S Q',
              { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, S, S] }));
            const annot = ctx.register(ctx.obj({
              Type: 'Annot', Subtype: 'Text', Rect: [x, y, x + S, y + S],
              Contents: PDFHexString.fromText(a.text), T: PDFHexString.fromText('upmypdf'),
              Name: 'Comment', C: [1, 0.88, 0.3], F: 28, AP: { N: ap },
            }));
            page.node.addAnnot(annot);
          }
        }
      }
      const bytes = await doc.save({ useObjectStreams: true });
      showResult('annotate', bytes, `${baseName(f.name)}_annotated.pdf`, 'application/pdf', `${count()} mark${count() > 1 ? 's' : ''} added · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('annotate', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = !(st.file && count() > 0);
    }
  });
}
