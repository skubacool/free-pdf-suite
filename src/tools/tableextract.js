export function initTableExtract() {
  const { $, setupDropzone, hideResult, showResult, setStatus } = window.appHelpers;

  const st = { file: null };
  const dz = $('#dz-tableextract');
  if (!dz) return;

  setupDropzone('tableextract', ([f]) => {
    st.file = f;
    $('#picked-tableextract').textContent = `Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
    $('#btn-tableextract').disabled = false;
  });

  $('#btn-tableextract').addEventListener('click', async () => {
    const f = st.file;
    if (!f) return;
    
    const btn = $('#btn-tableextract');
    btn.disabled = true;
    hideResult('tableextract');
    setStatus('tableextract', 'Extracting tables to CSV...', 'working');

    try {
      const arr = new Uint8Array(await f.arrayBuffer());
      const loadingTask = window.pdfjsLib.getDocument({ data: arr });
      const pdf = await loadingTask.promise;
      
      let csvContent = "";
      let totalRows = 0;

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        
        // Group items by Y coordinate (roughly identifying rows)
        // Y is transform[5]
        const rows = {};
        const yTolerance = 5; // Combine items within 5 points vertically
        
        textContent.items.forEach(item => {
          const y = item.transform[5];
          const x = item.transform[4];
          const text = item.str.trim();
          
          if (!text) return;
          
          // Find if an existing row matches this Y within tolerance
          let matchedY = Object.keys(rows).find(ry => Math.abs(parseFloat(ry) - y) < yTolerance);
          
          if (!matchedY) {
            matchedY = y;
            rows[matchedY] = [];
          }
          
          rows[matchedY].push({ x, text });
        });
        
        // Sort rows by Y descending (PDF coordinates usually bottom-up)
        const sortedY = Object.keys(rows).sort((a, b) => parseFloat(b) - parseFloat(a));
        
        for (const y of sortedY) {
          const rowItems = rows[y];
          // Sort items in row by X ascending
          rowItems.sort((a, b) => a.x - b.x);
          
          const csvRow = rowItems.map(item => {
            // Escape quotes and wrap in quotes if contains comma
            let t = item.text.replace(/"/g, '""');
            if (t.includes(',') || t.includes('\n') || t.includes('"')) {
              t = `"${t}"`;
            }
            return t;
          }).join(',');
          
          csvContent += csvRow + '\n';
          totalRows++;
        }
        
        csvContent += '\n'; // Empty line between pages
      }

      if (!csvContent.trim()) {
        setStatus('tableextract', '⚠️ No text found in document.', 'error');
        btn.disabled = false;
        return;
      }

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      
      const dlBtn = $('#dl-tableextract');
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = `Extracted_Table_${f.name.replace('.pdf', '')}.csv`;
        a.click();
      };

      $('#info-tableextract').textContent = `Extracted ${totalRows} rows of data.`;
      showResult('tableextract');
      setStatus('tableextract', '✅ CSV extraction complete!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('tableextract', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
