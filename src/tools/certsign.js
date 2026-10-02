// Digitally Sign PDF with a Certificate — a real cryptographic signature
// (PKCS#7 / CMS detached, adbe.pkcs7.detached, SHA-256), not a picture of a
// signature. If the file is changed afterwards, PDF readers flag the signature
// as broken. Bring your own .p12/.pfx certificate or create a self-signed one.
// The private key is used inside this page and never uploaded.
//
// Steps: add an empty signature field with a fixed-size /Contents placeholder
// and a /ByteRange placeholder, save with a classic cross-reference table so the
// byte offsets are stable, then hash every byte except the placeholder, sign the
// digest with node-forge, and write the signature into the placeholder.
const FORGE_URL = 'https://cdn.jsdelivr.net/npm/node-forge@1.3.1/dist/forge.min.js';
const pad10 = (n) => String(n).padStart(10, '0');

const indexOfBytes = (hay, needle, from = 0) => {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
};
const toBin = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
};
const pdfDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(), sg = off >= 0 ? '+' : '-', ah = Math.abs(off);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sg}${p(Math.floor(ah / 60))}'${p(ah % 60)}'`;
};

export function initCertSign() {
  const { $, $$, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, renderPreview, getRotatedOrigin, loadScriptOnce, PDFLib } = window.appHelpers;
  const { PDFDocument, PDFName, PDFHexString, PDFString, PDFNumber } = PDFLib;
  if (!$('#dz-certsign')) return;

  const st = { file: null, doc: null, pageNum: 1, box: null, mode: 'file', lastP12: null };
  const wrap = () => $('#wrap-certsign');
  const loadForge = () => loadScriptOnce(FORGE_URL, 'forge');
  const utf8dec = (s) => { try { return decodeURIComponent(escape(s)); } catch (_) { return s; } };
  const updateReady = () => { $('#btn-certsign').disabled = !st.file; };

  // ---- certificate source toggle
  const refreshMode = () => {
    st.mode = $('input[name="cs-mode"]:checked').value;
    $('#cs-file-box').classList.toggle('hidden', st.mode !== 'file');
    $('#cs-new-box').classList.toggle('hidden', st.mode !== 'new');
  };
  $$('input[name="cs-mode"]').forEach((r) => r.addEventListener('change', refreshMode));
  refreshMode();
  $('#cs-vis').addEventListener('change', () => {
    $('#cs-place').classList.toggle('hidden', !$('#cs-vis').checked);
    if (!$('#cs-vis').checked) { st.box = null; drawBox(); }
  });

  // ---- placement of the visible stamp
  const drawBox = () => {
    $$('.cs-box', wrap()).forEach((m) => m.remove());
    if (!st.box || st.box.page !== st.pageNum) return;
    const b = st.box, d = document.createElement('div');
    d.className = 'cs-box';
    d.style.cssText = `position:absolute;left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%;background:rgba(16,185,129,.18);border:1.5px dashed #059669;pointer-events:none;font:600 10px sans-serif;color:#047857;padding:2px 4px;`;
    d.textContent = 'Signature here';
    wrap().appendChild(d);
  };
  const cv = () => $('#preview-certsign');
  const relPos = (e) => { const r = cv().getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  let ds = null;
  cv().style.touchAction = 'none';
  cv().addEventListener('pointerdown', (e) => { if (!st.doc || !$('#cs-vis').checked) return; ds = relPos(e); cv().setPointerCapture(e.pointerId); });
  cv().addEventListener('pointermove', (e) => {
    if (!ds) return;
    const p = relPos(e);
    st.box = { page: st.pageNum, x: Math.min(ds.x, p.x), y: Math.min(ds.y, p.y), w: Math.abs(p.x - ds.x), h: Math.abs(p.y - ds.y) };
    drawBox();
  });
  const endDrag = () => { if (ds && st.box && (st.box.w < 0.03 || st.box.h < 0.015)) { st.box = null; drawBox(); } ds = null; };
  cv().addEventListener('pointerup', endDrag);
  cv().addEventListener('pointercancel', endDrag);

  setupDropzone('certsign', async ([f]) => {
    try {
      st.file = f; st.box = null; hideResult('certsign');
      setStatus('certsign', 'Loading preview…');
      st.doc = await loadPdfJs(await f.arrayBuffer());
      st.pageNum = 1;
      $('#page-certsign').value = 1;
      $('#page-certsign').max = st.doc.numPages;
      $('#pages-certsign').textContent = `/ ${st.doc.numPages}`;
      $('#picked-certsign').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
      $('#work-certsign').classList.remove('hidden');
      await renderPreview(st, '#preview-certsign', '#wrap-certsign');
      drawBox();
      setStatus('certsign', '');
    } catch (err) {
      setStatus('certsign', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
    }
    updateReady();
  });
  $('#page-certsign').addEventListener('change', async () => {
    if (!st.doc) return;
    st.pageNum = Math.min(Math.max(1, +$('#page-certsign').value || 1), st.doc.numPages);
    $('#page-certsign').value = st.pageNum;
    await renderPreview(st, '#preview-certsign', '#wrap-certsign');
    drawBox();
  });

  // ---- certificates
  const certName = (cert) => {
    const a = cert.subject.getField('CN') || cert.subject.getField('O');
    return a ? utf8dec(String(a.value)) : 'Signer';
  };
  const readP12 = async (forge, file, password) => {
    const der = forge.util.createBuffer(toBin(new Uint8Array(await file.arrayBuffer())));
    let p12;
    try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), password); } catch (e) {
      throw new Error(/mac|password|invalid/i.test(String(e.message)) ? 'Could not open the certificate — wrong password?' : `Could not read that certificate file (${e.message}). If it was exported with very new encryption, re-export it with an older (3DES/SHA-1) option.`);
    }
    const keys = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])
      .concat(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []);
    const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean);
    if (!keys.length || !keys[0].key) throw new Error('That file has no private key in it.');
    const key = keys[0].key;
    const mine = certs.find((c) => c.publicKey && c.publicKey.n && c.publicKey.n.equals(key.n)) || certs[0];
    if (!mine) throw new Error('That file has no certificate in it.');
    // forge hands back UTF-8 names as raw bytes; decode them so the signer
    // info it re-encodes matches the certificate byte for byte (non-Latin names).
    mine.issuer.attributes.forEach((a) => {
      if (a.valueTagClass === forge.asn1.Type.UTF8 && typeof a.value === 'string') a.value = utf8dec(a.value);
    });
    return { key, cert: mine, chain: certs.filter((c) => c !== mine) };
  };
  const makeSelfSigned = async (forge, { cn, org, email, years, password }) => {
    const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const priv = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(toBin(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)))));
    const pub = forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(toBin(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)))));
    const cert = forge.pki.createCertificate();
    cert.publicKey = pub;
    cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
    cert.validity.notBefore = new Date(Date.now() - 3600e3);
    cert.validity.notAfter = new Date(Date.now() + years * 365 * 86400e3);
    const utf = forge.asn1.Type.UTF8;
    const attrs = [{ name: 'commonName', value: cn, valueTagClass: utf }];
    if (org) attrs.push({ name: 'organizationName', value: org, valueTagClass: utf });
    if (email) attrs.push({ name: 'emailAddress', value: email });
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    ]);
    cert.sign(priv, forge.md.sha256.create());
    const p12 = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(priv, [cert], password, { algorithm: '3des', friendlyName: cn })).getBytes();
    st.lastP12 = new Blob([Uint8Array.from(p12, (c) => c.charCodeAt(0))], { type: 'application/x-pkcs12' });
    return { key: priv, cert, chain: [] };
  };

  // ---- the visible stamp is an image, so Thai/any-script names render
  const stampPng = async (name, reason, when) => {
    const W = 560, H = 190;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    try { await document.fonts.load('16px "Sarabun"'); await document.fonts.load('16px "Noto Sans Thai"'); } catch (_) {}
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#1d4ed8'; g.lineWidth = 4; g.strokeRect(2, 2, W - 4, H - 4);
    g.fillStyle = '#1d4ed8';
    const fam = '"Sarabun","Noto Sans Thai","Segoe UI",Arial,sans-serif';
    g.font = `bold 22px ${fam}`; g.fillText('Digitally signed by', 18, 36);
    g.fillStyle = '#111827'; g.font = `bold 34px ${fam}`;
    let n = name;
    while (g.measureText(n).width > W - 36 && n.length > 3) n = n.slice(0, -2);
    g.fillText(n === name ? n : `${n}…`, 18, 82);
    g.fillStyle = '#374151'; g.font = `22px ${fam}`;
    g.fillText(`Date: ${when}`, 18, 122);
    if (reason) { let r = `Reason: ${reason}`; while (g.measureText(r).width > W - 36 && r.length > 8) r = r.slice(0, -2); g.fillText(r, 18, 156); }
    return new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
  };

  $('#cs-save-p12').addEventListener('click', () => {
    if (!st.lastP12) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(st.lastP12);
    a.download = 'my-signing-certificate.p12';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  $('#btn-certsign').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    const btn = $('#btn-certsign');
    btn.disabled = true;
    hideResult('certsign');
    $('#cs-save-p12').classList.add('hidden');
    st.lastP12 = null;
    try {
      setStatus('certsign', 'Loading signing engine…');
      const forge = await loadForge();
      let id;
      if (st.mode === 'file') {
        const p12 = $('#cs-p12').files[0];
        if (!p12) throw new Error('Choose your certificate file (.p12 or .pfx) first.');
        setStatus('certsign', 'Opening your certificate…');
        id = await readP12(forge, p12, $('#cs-pw').value);
      } else {
        const cn = $('#cs-cn').value.trim(), pw = $('#cs-newpw').value;
        if (!cn) throw new Error('Enter the name to put on the certificate.');
        if (pw.length < 4) throw new Error('Choose a password (4+ characters) to protect the certificate file you can save.');
        setStatus('certsign', 'Creating your certificate…');
        id = await makeSelfSigned(forge, { cn, org: $('#cs-org').value.trim(), email: $('#cs-email').value.trim(), years: Math.max(1, +$('#cs-years').value || 3), password: pw });
      }
      const name = certName(id.cert);
      const now = new Date();
      const reason = $('#cs-reason').value.trim(), location = $('#cs-location').value.trim();

      setStatus('certsign', 'Preparing the document…');
      const doc = await PDFDocument.load(await f.arrayBuffer(), { updateMetadata: false });
      const ctx = doc.context;
      const pages = doc.getPages();
      const visible = $('#cs-vis').checked && st.box;
      const page = pages[visible ? st.box.page - 1 : 0];
      let rect = [0, 0, 0, 0];
      if (visible) {
        const { width: W, height: H } = page.getSize();
        const rot = ((page.getRotation().angle % 360) + 360) % 360;
        const [Wv, Hv] = rot % 180 ? [H, W] : [W, H];
        const b = st.box;
        const map = (nx, ny) => { const vx = nx * Wv, vy = ny * Hv; return rot === 90 ? [vy, vx] : rot === 180 ? [W - vx, vy] : rot === 270 ? [W - vy, H - vx] : [vx, H - vy]; };
        const [ax, ay] = map(b.x, b.y), [bx, by] = map(b.x + b.w, b.y + b.h);
        rect = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
        const png = await doc.embedPng(await stampPng(name, reason, now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })));
        const bw = b.w * Wv, bh = b.h * Hv;
        const fit = Math.min(bw / png.width, bh / png.height);
        const iw = png.width * fit, ih = png.height * fit;
        const o = getRotatedOrigin((b.x + b.w / 2) * Wv, (b.y + b.h / 2) * Hv, iw, ih, page);
        page.drawImage(png, { x: o.x, y: o.y, width: iw, height: ih, rotate: o.rotate });
      }

      // ---- signature field with placeholders
      const mk = (SIZE) => {
        const sig = ctx.obj({
          Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
          ByteRange: [0, 1111111111, 1111111111, 1111111111],
          Contents: PDFHexString.of('0'.repeat(SIZE * 2)),
          M: PDFString.of(pdfDate(now)),
          Name: PDFHexString.fromText(name),
        });
        if (reason) sig.set(PDFName.of('Reason'), PDFHexString.fromText(reason));
        if (location) sig.set(PDFName.of('Location'), PDFHexString.fromText(location));
        return ctx.register(sig);
      };
      let bytes = null;
      const size = 12288; // bytes reserved for the signature (fits a 3-certificate chain)
      {
        const sigRef = mk(size);
        const widget = ctx.register(ctx.obj({
          Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: rect, V: sigRef,
          T: PDFString.of(`Signature${Date.now() % 100000}`), F: 132, P: page.ref,
        }));
        page.node.addAnnot(widget);
        const form = doc.getForm();
        form.acroForm.addField(widget);
        form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
        const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false });

        // ---- locate placeholders, set ByteRange, hash everything else
        const cPos = indexOfBytes(saved, '/Contents <' + '0'.repeat(64));
        if (cPos < 0) throw new Error('Internal error: could not place the signature.');
        const lt = cPos + '/Contents '.length;
        const gt = saved.indexOf(0x3e, lt); // '>'
        // pdf-lib prints arrays with inner spaces, so find the span generically
        const brKey = indexOfBytes(saved, '/ByteRange');
        const brOpen = brKey < 0 ? -1 : saved.indexOf(0x5b, brKey); // '['
        const brClose = brOpen < 0 ? -1 : saved.indexOf(0x5d, brOpen); // ']'
        if (gt < 0 || brClose < 0) throw new Error('Internal error: could not place the signature.');
        const a = lt, b2 = gt + 1;
        let br = `[0 ${pad10(a)} ${pad10(b2)} ${pad10(saved.length - b2)}]`;
        const span = brClose - brOpen + 1;
        if (br.length > span) throw new Error('Internal error: could not place the signature.');
        br = br.padEnd(span, ' ');
        for (let i = 0; i < br.length; i++) saved[brOpen + i] = br.charCodeAt(i);
        const signed = new Uint8Array(a + (saved.length - b2));
        signed.set(saved.subarray(0, a), 0);
        signed.set(saved.subarray(b2), a);

        setStatus('certsign', 'Signing…');
        const p7 = forge.pkcs7.createSignedData();
        p7.content = forge.util.createBuffer(toBin(signed));
        p7.addCertificate(id.cert);
        id.chain.forEach((c) => p7.addCertificate(c));
        p7.addSigner({
          key: id.key, certificate: id.cert, digestAlgorithm: forge.pki.oids.sha256,
          authenticatedAttributes: [
            { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
            { type: forge.pki.oids.messageDigest },
            { type: forge.pki.oids.signingTime, value: now },
          ],
        });
        p7.sign({ detached: true });
        const hex = forge.util.bytesToHex(forge.asn1.toDer(p7.toAsn1()).getBytes());
        if (hex.length > size * 2 - 2) throw new Error('The certificate chain is too large to embed.');
        const fill = hex + '0'.repeat(size * 2 - hex.length);
        for (let i = 0; i < fill.length; i++) saved[lt + 1 + i] = fill.charCodeAt(i);
        bytes = saved;
      }
      if (st.mode === 'new') $('#cs-save-p12').classList.remove('hidden');
      showResult('certsign', bytes, `${baseName(f.name)}_signed.pdf`, 'application/pdf',
        `Signed by ${name} · ${fmtBytes(bytes.length)}${st.mode === 'new' ? ' · self-signed: readers will show the signer as “unverified” unless they trust your certificate' : ''}`);
      setStatus('certsign', '');
    } catch (err) {
      setStatus('certsign', `❌ ${err.message || err}`, 'error');
    } finally {
      btn.disabled = !st.file;
    }
  });
}
