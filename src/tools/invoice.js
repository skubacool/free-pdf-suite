export function initInvoice() {
  const { $, hideResult, showResult, setStatus, PDFLib, getUnicodeFont, adjustThai } = window.appHelpers;

  const btn = $('#btn-invoice');
  if (!btn) return;

  // "Description - Amount": split on the LAST spaced dash so hyphenated
  // descriptions ("Wi-Fi setup - $80") keep their hyphen.
  const splitItem = (line) => {
    const m = /^(.*\S)\s+[-–—]\s+(\S.*)$/.exec(line.trim());
    return m ? { desc: m[1], amt: m[2].trim() } : { desc: line.trim(), amt: '' };
  };
  const toNumber = (amt) => {
    const clean = amt.replace(/[^\d.\-]/g, '');
    return /\d/.test(clean) && !isNaN(+clean) ? +clean : null;
  };

  btn.addEventListener('click', async () => {
    const fromText = ($('#invoice-from')?.value || '').trim();
    const invNo = ($('#invoice-no')?.value || '').trim();
    const toName = $('#invoice-to').value.trim();
    const itemsText = $('#invoice-items').value.trim();
    let total = $('#invoice-total').value.trim();

    if (!toName || !itemsText) {
      setStatus('invoice', '❌ Please fill in Bill To and at least one item.', 'error');
      return;
    }

    const items = itemsText.split('\n').filter((l) => l.trim()).map(splitItem);
    if (!total) {
      // Sum the amounts when every item has a numeric one, keeping the
      // currency prefix of the first ("$", "฿", "THB ", ...).
      const nums = items.map((i) => toNumber(i.amt));
      if (nums.some((n) => n === null)) {
        setStatus('invoice', '❌ Enter a Total, or give every item a numeric amount so it can be added up.', 'error');
        return;
      }
      const prefix = (/^[^\d\-]*/.exec(items[0].amt) || [''])[0];
      total = prefix + nums.reduce((a, b) => a + b, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    btn.disabled = true;
    hideResult('invoice');
    setStatus('invoice', 'Generating Invoice...', 'working');

    try {
      const pdfDoc = await PDFLib.PDFDocument.create();
      const allText = `INVOICE Bill To From Date Description Amount Total ${fromText} ${invNo} ${toName} ${itemsText} ${total}`;
      const font = await getUnicodeFont(pdfDoc, allText);
      const { rgb } = PDFLib;

      const W = 595.28, H = 841.89, L = 50, R = 545; // A4
      let page = pdfDoc.addPage([W, H]);
      let y = 780;

      const draw = (txt, size, x, yPos, color = rgb(0, 0, 0)) =>
        page.drawText(adjustThai(txt), { x, y: yPos, size, font, color });
      const drawRight = (txt, size, yPos, color) =>
        draw(txt, size, R - font.widthOfTextAtSize(adjustThai(txt), size), yPos, color);
      const drawLines = (txt, size, x) => {
        for (const line of txt.split('\n')) { draw(line, size, x, y); y -= size + 5; }
      };
      const newPage = () => { page = pdfDoc.addPage([W, H]); y = 780; };

      // Header
      draw('INVOICE', 26, L, y, rgb(0.15, 0.25, 0.8));
      if (invNo) drawRight(`Invoice # ${invNo}`, 12, y + 8);
      drawRight(`Date: ${new Date().toLocaleDateString()}`, 12, y - 10);
      y -= 50;

      if (fromText) {
        draw('From:', 12, L, y, rgb(0.4, 0.4, 0.4));
        y -= 18;
        drawLines(fromText, 12, L);
        y -= 16;
      }
      draw('Bill To:', 12, L, y, rgb(0.4, 0.4, 0.4));
      y -= 18;
      drawLines(toName, 12, L);
      y -= 30;

      // Items table
      const tableHeader = () => {
        draw('Description', 12, L, y);
        drawRight('Amount', 12, y);
        page.drawLine({ start: { x: L, y: y - 6 }, end: { x: R, y: y - 6 }, thickness: 1, color: rgb(0.5, 0.5, 0.5) });
        y -= 26;
      };
      tableHeader();
      for (const { desc, amt } of items) {
        if (y < 90) { newPage(); tableHeader(); }
        draw(desc, 12, L, y);
        if (amt) drawRight(amt, 12, y);
        y -= 20;
      }

      if (y < 120) newPage();
      y -= 14;
      page.drawLine({ start: { x: 330, y }, end: { x: R, y }, thickness: 1, color: rgb(0, 0, 0) });
      y -= 24;
      draw('Total', 14, 330, y);
      drawRight(total, 14, y);

      const out = await pdfDoc.save();
      const stamp = invNo ? invNo.replace(/[^\w.-]+/g, '_') : new Date().toISOString().slice(0, 10);
      showResult('invoice', out, `Invoice_${stamp}.pdf`, 'application/pdf',
        `${items.length} item${items.length === 1 ? '' : 's'} · Total ${total}`);

    } catch (e) {
      console.error(e);
      setStatus('invoice', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
