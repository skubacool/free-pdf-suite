// Create Fillable PDF Form — open any PDF (or start from a blank page), drag
// to place text boxes, check boxes, drop-downs and radio buttons, and download
// a PDF with real AcroForm fields that Acrobat, Preview and browsers can fill
// in. Built on pdf-lib's form API; runs entirely in the browser.
const TYPES = [
  ['text', '🔤', 'Text box'],
  ['multi', '📝', 'Multi-line'],
  ['check', '☑️', 'Check box'],
  ['drop', '🔽', 'Drop-down'],
  ['radio', '🔘', 'Radio button'],
];
const LABEL = { text: 'Text', multi: 'Text area', check: 'Checkbox', drop: 'Dropdown', radio: 'Radio' };

export function initFormCreate() {
  const { $, $$, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, renderPreview, PDFLib, feedTool } = window.appHelpers;
  const { PDFDocument, rgb } = PDFLib;
  if (!$('#dz-formcreate')) return;

  const st = { file: null, doc: null, pageNum: 1, fields: [], type: 'text', seq: 0 };
  const wrap = () => $('#wrap-formcreate');
  const updateReady = () => {
    $('#btn-formcreate').disabled = !(st.file && st.fields.length);
    $('#fc-count').textContent = st.fields.length ? `${st.fields.length} field${st.fields.length > 1 ? 's' : ''}` : '';
  };

  $('#fc-types').innerHTML = TYPES.map(([k, ic, nm]) => `<button type="button" data-fctype="${k}" class="btn text-sm rounded-lg px-3 py-1.5 border border-slate-300">${ic} ${nm}</button>`).join('');
  const refreshTypes = () => $$('[data-fctype]').forEach((b) => {
    const on = b.dataset.fctype === st.type;
    b.classList.toggle('bg-brand-50', on); b.classList.toggle('border-brand-600', on); b.classList.toggle('text-brand-700', on); b.classList.toggle('font-semibold', on);
  });
  $$('[data-fctype]').forEach((b) => b.addEventListener('click', () => { st.type = b.dataset.fctype; refreshTypes(); }));
  refreshTypes();

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const drawBoxes = () => {
    $$('.fc-box', wrap()).forEach((m) => m.remove());
    st.fields.filter((f) => f.page === st.pageNum).forEach((f) => {
      const d = document.createElement('div');
      d.className = 'fc-box';
      d.style.cssText = `position:absolute;left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%;background:rgba(37,99,235,.14);border:1.5px solid #2563eb;font:600 10px/1 sans-serif;color:#1d4ed8;overflow:hidden;padding:2px 3px;pointer-events:none;`;
      d.textContent = f.name;
      wrap().appendChild(d);
    });
  };
  const renderList = () => {
    const box = $('#fc-list');
    if (!st.fields.length) { box.innerHTML = '<p class="text-sm text-slate-500">No fields yet — pick a type above, then drag on the page.</p>'; return; }
    box.innerHTML = st.fields.map((f, i) => `
      <div class="flex flex-wrap items-center gap-2 border border-slate-200 rounded-xl px-3 py-2 bg-slate-50" data-i="${i}">
        <span class="text-xs font-semibold text-slate-500 w-24">${LABEL[f.type]} · p${f.page}</span>
        <input data-k="name" value="${esc(f.name)}" class="border border-slate-300 rounded-lg px-2 py-1 text-sm w-40" aria-label="Field name" />
        ${f.type === 'drop' ? `<input data-k="opts" value="${esc(f.opts)}" placeholder="Option 1, Option 2, Option 3" class="border border-slate-300 rounded-lg px-2 py-1 text-sm flex-1 min-w-[10rem]" aria-label="Options" />` : ''}
        ${f.type === 'radio' ? `<input data-k="opt" value="${esc(f.opt)}" placeholder="Choice label" class="border border-slate-300 rounded-lg px-2 py-1 text-sm w-32" aria-label="Choice" />` : ''}
        <label class="text-xs flex items-center gap-1"><input type="checkbox" data-k="req" ${f.req ? 'checked' : ''} /> Required</label>
        <button type="button" data-del class="ml-auto text-xs text-rose-600 hover:underline">Remove</button>
      </div>`).join('');
  };
  $('#fc-list').addEventListener('input', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const f = st.fields[+row.dataset.i], k = e.target.dataset.k;
    if (!f || !k) return;
    f[k] = k === 'req' ? e.target.checked : e.target.value;
    if (k === 'name') drawBoxes();
  });
  $('#fc-list').addEventListener('click', (e) => {
    if (!e.target.matches('[data-del]')) return;
    st.fields.splice(+e.target.closest('[data-i]').dataset.i, 1);
    renderList(); drawBoxes(); updateReady();
  });

  // ---- drag to place
  let dragStart = null, ghost = null;
  const cv = () => $('#preview-formcreate');
  const relPos = (e) => {
    const r = cv().getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  cv().style.touchAction = 'none';
  cv().addEventListener('pointerdown', (e) => {
    if (!st.doc) return;
    dragStart = relPos(e);
    cv().setPointerCapture(e.pointerId);
    ghost = document.createElement('div');
    ghost.className = 'fc-box';
    ghost.style.cssText = 'position:absolute;background:rgba(37,99,235,.18);border:1.5px dashed #2563eb;pointer-events:none;';
    wrap().appendChild(ghost);
  });
  cv().addEventListener('pointermove', (e) => {
    if (!dragStart || !ghost) return;
    const p = relPos(e);
    ghost.style.left = `${Math.min(dragStart.x, p.x) * 100}%`; ghost.style.top = `${Math.min(dragStart.y, p.y) * 100}%`;
    ghost.style.width = `${Math.abs(p.x - dragStart.x) * 100}%`; ghost.style.height = `${Math.abs(p.y - dragStart.y) * 100}%`;
  });
  const finish = (e) => {
    if (!dragStart) return;
    const p = relPos(e);
    let x = Math.min(dragStart.x, p.x), y = Math.min(dragStart.y, p.y);
    let w = Math.abs(p.x - dragStart.x), h = Math.abs(p.y - dragStart.y);
    if (ghost) { ghost.remove(); ghost = null; }
    dragStart = null;
    const small = w < 0.01 || h < 0.008;
    const sq = st.type === 'check' || st.type === 'radio';
    const asp = cv().width / cv().height;
    if (small) { // a simple click drops a sensible default size
      if (sq) { w = 0.035; h = 0.035 * asp; } else if (st.type === 'multi') { w = 0.5; h = 0.16; } else { w = 0.3; h = 0.035; }
      x = Math.min(x, 1 - w); y = Math.min(y, 1 - h);
    } else if (sq) { h = w * asp; }
    const n = ++st.seq;
    const base = { text: 'Text', multi: 'TextArea', check: 'Checkbox', drop: 'Dropdown', radio: 'Radio' }[st.type];
    st.fields.push({ type: st.type, page: st.pageNum, x, y, w, h, name: st.type === 'radio' ? (lastRadio() || `Radio${n}`) : `${base}${n}`, opts: 'Option 1, Option 2, Option 3', opt: `Choice ${n}`, req: false });
    renderList(); drawBoxes(); updateReady();
    setStatus('formcreate', '');
  };
  const lastRadio = () => { const r = [...st.fields].reverse().find((f) => f.type === 'radio'); return r ? r.name : ''; };
  cv().addEventListener('pointerup', finish);
  cv().addEventListener('pointercancel', finish);

  const load = async (f) => {
    st.file = f; st.fields = []; st.seq = 0; hideResult('formcreate');
    setStatus('formcreate', 'Loading preview…');
    st.doc = await loadPdfJs(await f.arrayBuffer());
    st.pageNum = 1;
    $('#page-formcreate').value = 1;
    $('#page-formcreate').max = st.doc.numPages;
    $('#pages-formcreate').textContent = `/ ${st.doc.numPages}`;
    $('#picked-formcreate').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#work-formcreate').classList.remove('hidden');
    await renderPreview(st, '#preview-formcreate', '#wrap-formcreate');
    renderList(); drawBoxes();
    setStatus('formcreate', 'Pick a field type, then drag on the page where it should go (or just click for a default size).');
  };
  setupDropzone('formcreate', async ([f]) => {
    try { await load(f); } catch (err) {
      setStatus('formcreate', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
    }
    updateReady();
  });
  $('#fc-blank').addEventListener('click', async () => {
    try {
      const d = await PDFDocument.create();
      d.addPage([595.28, 841.89]);
      const bytes = await d.save();
      await load(new File([bytes], 'blank-form.pdf', { type: 'application/pdf' }));
    } catch (err) { setStatus('formcreate', `❌ ${err.message || err}`, 'error'); }
    updateReady();
  });
  $('#page-formcreate').addEventListener('change', async () => {
    if (!st.doc) return;
    st.pageNum = Math.min(Math.max(1, +$('#page-formcreate').value || 1), st.doc.numPages);
    $('#page-formcreate').value = st.pageNum;
    await renderPreview(st, '#preview-formcreate', '#wrap-formcreate');
    drawBoxes();
  });

  $('#btn-formcreate').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    const btn = $('#btn-formcreate');
    btn.disabled = true;
    hideResult('formcreate');
    try {
      setStatus('formcreate', 'Building the form…');
      const doc = await PDFDocument.load(await f.arrayBuffer());
      const form = doc.getForm();
      const pages = doc.getPages();
      const radios = {};
      const seen = new Set();
      for (const fd of st.fields) {
        const name = (fd.name || '').trim();
        if (!name) throw new Error('Every field needs a name.');
        const page = pages[fd.page - 1];
        const { width: W, height: H } = page.getSize();
        const rot = ((page.getRotation().angle % 360) + 360) % 360;
        const [Wv, Hv] = rot % 180 ? [H, W] : [W, H];
        const map = (nx, ny) => { const vx = nx * Wv, vy = ny * Hv; return rot === 90 ? [vy, vx] : rot === 180 ? [W - vx, vy] : rot === 270 ? [W - vy, H - vx] : [vx, H - vy]; };
        const [ax, ay] = map(fd.x, fd.y), [bx, by] = map(fd.x + fd.w, fd.y + fd.h);
        const box = { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay), borderWidth: 1, borderColor: rgb(0.2, 0.3, 0.7), backgroundColor: rgb(0.93, 0.95, 1) };
        if (fd.type !== 'radio') {
          if (seen.has(name)) throw new Error(`Two fields are named “${name}”. Give each one a unique name.`);
          seen.add(name);
        }
        if (fd.type === 'text' || fd.type === 'multi') {
          const tf = form.createTextField(name);
          if (fd.type === 'multi') tf.enableMultiline();
          if (fd.req) tf.enableRequired();
          tf.addToPage(page, box);
        } else if (fd.type === 'check') {
          const cb = form.createCheckBox(name);
          if (fd.req) cb.enableRequired();
          cb.addToPage(page, box);
        } else if (fd.type === 'drop') {
          const dd = form.createDropdown(name);
          const opts = fd.opts.split(',').map((s) => s.trim()).filter(Boolean);
          dd.addOptions(opts.length ? opts : ['Option 1']);
          if (fd.req) dd.enableRequired();
          dd.addToPage(page, box);
        } else if (fd.type === 'radio') {
          const rg = radios[name] || (radios[name] = form.createRadioGroup(name));
          if (fd.req) rg.enableRequired();
          rg.addOptionToPage((fd.opt || 'Choice').trim() || 'Choice', page, box);
        }
      }
      const bytes = await doc.save({ useObjectStreams: true });
      showResult('formcreate', bytes, `${baseName(f.name)}_form.pdf`, 'application/pdf', `${st.fields.length} fillable field${st.fields.length > 1 ? 's' : ''} · ${fmtBytes(bytes.length)}`);
    } catch (err) {
      setStatus('formcreate', `❌ ${/already exists/i.test(String(err)) ? 'A field with that name already exists in this PDF — rename yours.' : err.message || err}`, 'error');
    } finally {
      btn.disabled = !(st.file && st.fields.length);
    }
  });
}
