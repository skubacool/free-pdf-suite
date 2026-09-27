export function initBookmark() {
  const { $, setupDropzone, hideResult, showResult, setStatus, PDFLib, getUnicodeFont, adjustThai } = window.appHelpers;

  const st = { file: null };
  const dz = $('#dz-bookmark');
  if (!dz) return;

  setupDropzone('bookmark', ([f]) => {
    st.file = f;
    $('#picked-bookmark').textContent = `Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
    $('#btn-bookmark').disabled = false;
    hideResult('bookmark');
    setStatus('bookmark', '');
  });

  $('#btn-bookmark').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;

    const tocText = $('#text-toc').value.trim();
    if (!tocText) {
      setStatus('bookmark', '❌ Please enter Table of Contents data.', 'error');
      return;
    }
    const wantTocPage = $('#tocpage-bookmark')?.checked ?? true;
    const wantOutline = $('#outline-bookmark')?.checked ?? true;
    if (!wantTocPage && !wantOutline) {
      setStatus('bookmark', '❌ Choose a TOC page, sidebar bookmarks, or both.', 'error');
      return;
    }

    const btn = $('#btn-bookmark');
    btn.disabled = true;
    hideResult('bookmark');
    setStatus('bookmark', 'Generating Table of Contents...', 'working');

    try {
      const arr = new Uint8Array(await f.arrayBuffer());
      const pdfDoc = await PDFLib.PDFDocument.load(arr, { ignoreEncryption: true });
      const { PDFName, PDFHexString, rgb } = PDFLib;
      const totalPages = pdfDoc.getPageCount();

      // Parse "PageNumber: Title" lines; page numbers refer to the original PDF.
      const parsed = tocText.split('\n').map((line) => {
        const m = /^\s*(\d+)\s*[:.)-]\s*(.+?)\s*$/.exec(line);
        return m ? { pageNum: parseInt(m[1], 10), title: m[2] } : null;
      }).filter(Boolean);
      const entries = parsed.filter((e) => e.pageNum >= 1 && e.pageNum <= totalPages);
      const skipped = parsed.length - entries.length;

      if (entries.length === 0) {
        setStatus('bookmark', parsed.length
          ? `❌ Every page number is outside this PDF (it has ${totalPages} pages).`
          : '❌ Invalid format. Use "PageNum: Title" on each line.', 'error');
        return;
      }

      // Lay out the TOC first so we know how many pages it inserts ahead of
      // the original ones (that offset decides where each link points).
      const TOP = 780, BOTTOM = 50, STEP = 25, FIRST_START = TOP - 40;
      const layout = []; // { tocPage, y, entry }
      let tocPage = 0, y = FIRST_START;
      for (const entry of entries) {
        if (y < BOTTOM) { tocPage++; y = TOP; }
        layout.push({ tocPage, y, entry });
        y -= STEP;
      }
      const tocCount = wantTocPage ? tocPage + 1 : 0;
      const target = (pageNum) => pdfDoc.getPage(tocCount + pageNum - 1).ref;

      if (wantTocPage) {
        const font = await getUnicodeFont(pdfDoc, `Table of Contents ${entries.map((e) => e.title).join(' ')}`);
        const tocPages = [];
        for (let i = 0; i < tocCount; i++) tocPages.push(pdfDoc.insertPage(i, [595.28, 841.89])); // A4
        tocPages[0].drawText(adjustThai('Table of Contents'), { x: 50, y: TOP, size: 24, font });

        const fontSize = 13, left = 50, right = 545;
        const dotW = font.widthOfTextAtSize('.', fontSize);
        for (const { tocPage: pi, y: ly, entry } of layout) {
          const page = tocPages[pi];
          let title = adjustThai(entry.title);
          const num = String(entry.pageNum);
          const numW = font.widthOfTextAtSize(num, fontSize);
          const maxTitleW = right - left - numW - 30;
          while (title.length > 1 && font.widthOfTextAtSize(title, fontSize) > maxTitleW) title = title.slice(0, -2) + '…';
          const titleW = font.widthOfTextAtSize(title, fontSize);
          const dots = '.'.repeat(Math.max(0, Math.floor((right - numW - left - titleW - 12) / dotW)));
          const color = rgb(0, 0.3, 0.8);
          page.drawText(title, { x: left, y: ly, size: fontSize, font, color });
          if (dots) page.drawText(dots, { x: left + titleW + 6, y: ly, size: fontSize, font, color: rgb(0.6, 0.6, 0.6) });
          page.drawText(num, { x: right - numW, y: ly, size: fontSize, font, color });

          // Make the whole line a clickable link to the target page
          const link = pdfDoc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [left, ly - 3, right, ly + fontSize],
            Border: [0, 0, 0],
            A: { Type: 'Action', S: 'GoTo', D: [target(entry.pageNum), 'Fit'] },
          });
          if (!page.node.Annots()) page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([]));
          page.node.Annots().push(pdfDoc.context.register(link));
        }
      }

      if (wantOutline) {
        // Real PDF bookmarks (the reader's sidebar outline). Replaces any existing outline.
        const ctx = pdfDoc.context;
        const outlinesRef = ctx.nextRef();
        const refs = entries.map(() => ctx.nextRef());
        entries.forEach((entry, i) => {
          const item = {
            Title: PDFHexString.fromText(entry.title),
            Parent: outlinesRef,
            Dest: [target(entry.pageNum), 'Fit'],
          };
          if (i > 0) item.Prev = refs[i - 1];
          if (i < refs.length - 1) item.Next = refs[i + 1];
          ctx.assign(refs[i], ctx.obj(item));
        });
        ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
        pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
        pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
      }

      const out = await pdfDoc.save();
      const parts = [];
      if (wantTocPage) parts.push(`${tocCount} TOC page${tocCount === 1 ? '' : 's'}`);
      if (wantOutline) parts.push(`${entries.length} bookmark${entries.length === 1 ? '' : 's'}`);
      showResult('bookmark', out, `${f.name.replace(/\.pdf$/i, '')}_bookmarked.pdf`, 'application/pdf',
        `Added ${parts.join(' + ')}.` + (skipped ? ` Skipped ${skipped} line${skipped === 1 ? '' : 's'} pointing past page ${totalPages}.` : ''));

    } catch (e) {
      console.error(e);
      setStatus('bookmark', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
