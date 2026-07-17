export function initInvoice() {
  const { $, hideResult, showResult, setStatus, PDFLib, getUnicodeFont, adjustThai } = window.appHelpers;

  const btn = $('#btn-invoice');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const toName = $('#invoice-to').value.trim();
    const itemsText = $('#invoice-items').value.trim();
    const total = $('#invoice-total').value.trim();
    
    if (!toName || !itemsText || !total) {
      setStatus('invoice', '❌ Please fill in all fields.', 'error');
      return;
    }

    btn.disabled = true;
    hideResult('invoice');
    setStatus('invoice', 'Generating Invoice...', 'working');

    try {
      const pdfDoc = await PDFLib.PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]); // A4
      
      const allText = `${toName} ${itemsText} ${total} Invoice`;
      const fontConf = await getUnicodeFont(pdfDoc, allText);
      const font = fontConf.font || await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
      const needsUnicode = fontConf.needsUnicode || false;

      let y = 780;
      const x = 50;
      
      const draw = (txt, size, xPos, yPos, color = PDFLib.rgb(0,0,0)) => {
        const text = needsUnicode ? adjustThai(txt) : txt;
        page.drawText(text, { x: xPos, y: yPos, size, font, color });
      };

      // Header
      draw('INVOICE', 24, x, y, PDFLib.rgb(0.2, 0.2, 0.8));
      y -= 40;
      
      const date = new Date().toLocaleDateString();
      draw(`Date: ${date}`, 12, x, y);
      y -= 40;

      draw('Bill To:', 14, x, y);
      y -= 20;
      draw(toName, 12, x, y);
      y -= 50;

      // Items table header
      draw('Description', 12, x, y);
      draw('Amount', 12, 450, y);
      page.drawLine({
        start: { x: x, y: y - 5 },
        end: { x: 545, y: y - 5 },
        thickness: 1,
        color: PDFLib.rgb(0.5, 0.5, 0.5)
      });
      y -= 25;

      // Parse items (assuming "Item Name - $Price" per line)
      const items = itemsText.split('\n').filter(i => i.trim());
      for (const item of items) {
        let desc = item;
        let amt = '';
        if (item.includes('-')) {
          const parts = item.split('-');
          amt = parts.pop().trim();
          desc = parts.join('-').trim();
        }
        draw(desc, 12, x, y);
        if (amt) draw(amt, 12, 450, y);
        y -= 20;
      }

      y -= 20;
      page.drawLine({
        start: { x: 350, y: y },
        end: { x: 545, y: y },
        thickness: 1,
        color: PDFLib.rgb(0, 0, 0)
      });
      y -= 25;

      draw('Total:', 14, 350, y);
      draw(total, 14, 450, y);

      const out = await pdfDoc.save();
      const blob = new Blob([out], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      const dlBtn = $('#dl-invoice');
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `Invoice_${Date.now()}.pdf`;
        a.click();
      };

      $('#info-invoice').textContent = `Invoice generated successfully.`;
      showResult('invoice');
      setStatus('invoice', '✅ Invoice created!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('invoice', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
