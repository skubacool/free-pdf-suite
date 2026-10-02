// PDF to PDF/A — make an archival copy (PDF/A-2b) of any PDF, in the browser.
//
// Real PDF/A needs every font embedded, no transparency or scripts, an sRGB
// output intent and matching XMP metadata. Reproducing an arbitrary PDF's
// original fonts and graphics under those rules is not reliable in a browser, so
// this tool takes the dependable route: each page is rendered to an image and
// rebuilt as a PDF/A-2b page, with the page's text written back as an invisible,
// fully embedded text layer so the archive stays searchable and copyable.
import { extractLines, addTextLayer } from './textlayer.js';
import { SRGB_ICC_B64 } from './srgbicc.js';

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const pdfDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};
const isoDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const rndHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

export function initPdfA() {
  const { $, setupDropzone, hideResult, showResult, setStatus, fmtBytes, baseName, loadPdfJs, canvasToJpeg, PDFLib } = window.appHelpers;
  const { PDFDocument, PDFName, PDFHexString, PDFString } = PDFLib;
  if (!$('#dz-pdfa')) return;
  const st = { file: null };

  setupDropzone('pdfa', ([f]) => {
    st.file = f;
    $('#picked-pdfa').textContent = `Selected: ${f.name} (${fmtBytes(f.size)})`;
    $('#btn-pdfa').disabled = false;
    hideResult('pdfa');
    setStatus('pdfa', '');
  });

  $('#btn-pdfa').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    const btn = $('#btn-pdfa');
    btn.disabled = true;
    hideResult('pdfa');
    try {
      const dpi = +$('#dpi-pdfa').value || 150;
      const SCALE = dpi / 72;
      const data = await f.arrayBuffer();
      const src = await loadPdfJs(data.slice(0));
      let title = baseName(f.name), author = '', subject = '';
      try {
        const meta = await src.getMetadata();
        title = (meta.info && meta.info.Title) || title;
        author = (meta.info && meta.info.Author) || '';
        subject = (meta.info && meta.info.Subject) || '';
      } catch (_) {}

      const out = await PDFDocument.create({ updateMetadata: false });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      for (let i = 1; i <= src.numPages; i++) {
        setStatus('pdfa', `Converting page ${i} of ${src.numPages}…`);
        const page = await src.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: SCALE });
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const jpg = await out.embedJpg(await canvasToJpeg(canvas, 0.85));
        const outPage = out.addPage([vp1.width, vp1.height]);
        outPage.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        try {
          const { lines } = await extractLines(page, { split: true });
          await addTextLayer(out, outPage, vp1.height, lines.map((l) => ({ text: l.str, x: l.x, w: l.w, base: l.base, size: l.size })), { latinEmbedded: true });
        } catch (e) { console.warn('[upmypdf] text layer skipped:', e && e.message); }
      }

      // ---- document information + matching XMP
      setStatus('pdfa', 'Writing PDF/A metadata…');
      const now = new Date(), ctxo = out.context;
      out.setTitle(title); out.setAuthor(author); out.setSubject(subject);
      out.setProducer('upmypdf.com PDF/A converter'); out.setCreator('upmypdf.com');
      out.setCreationDate(new Date(Math.floor(now.getTime() / 1000) * 1000)); out.setModificationDate(new Date(Math.floor(now.getTime() / 1000) * 1000));
      const d = new Date(Math.floor(now.getTime() / 1000) * 1000);
      const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>
   ${author ? `<dc:creator><rdf:Seq><rdf:li>${xmlEsc(author)}</rdf:li></rdf:Seq></dc:creator>` : ''}
   ${subject ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(subject)}</rdf:li></rdf:Alt></dc:description>` : ''}
   <xmp:CreatorTool>upmypdf.com</xmp:CreatorTool>
   <xmp:CreateDate>${isoDate(d)}</xmp:CreateDate>
   <xmp:ModifyDate>${isoDate(d)}</xmp:ModifyDate>
   <xmp:MetadataDate>${isoDate(d)}</xmp:MetadataDate>
   <pdf:Producer>upmypdf.com PDF/A converter</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
      const metaRef = ctxo.register(ctxo.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' }));
      out.catalog.set(PDFName.of('Metadata'), metaRef);

      // ---- sRGB output intent
      const icc = ctxo.register(ctxo.flateStream(b64ToBytes(SRGB_ICC_B64), { N: 3 }));
      const intent = ctxo.register(ctxo.obj({
        Type: 'OutputIntent', S: 'GTS_PDFA1',
        OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
        Info: PDFString.of('sRGB IEC61966-2.1'),
        DestOutputProfile: icc,
      }));
      out.catalog.set(PDFName.of('OutputIntents'), ctxo.obj([intent]));

      // ---- trailer file identifier
      ctxo.trailerInfo.ID = ctxo.obj([PDFHexString.of(rndHex(16)), PDFHexString.of(rndHex(16))]);

      const bytes = await out.save({ useObjectStreams: false });
      showResult('pdfa', bytes, `${baseName(f.name)}_PDFA.pdf`, 'application/pdf', `PDF/A-2b · ${src.numPages} page${src.numPages > 1 ? 's' : ''} · ${fmtBytes(bytes.length)}`);
      setStatus('pdfa', '');
    } catch (err) {
      setStatus('pdfa', `❌ ${err?.name === 'PasswordException' ? 'This PDF is password-protected — unlock it first.' : err.message || err}`, 'error');
    } finally {
      btn.disabled = !st.file;
    }
  });
}
