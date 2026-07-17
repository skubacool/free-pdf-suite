export function initBatchRename() {
  const { $, setupDropzone, hideResult, showResult, setStatus, baseName } = window.appHelpers;

  const st = { files: [] };
  const dz = $('#dz-batchrename');
  if (!dz) return;

  setupDropzone('batchrename', (files) => {
    st.files = Array.from(files);
    $('#picked-batchrename').textContent = `Selected: ${st.files.length} PDFs`;
    $('#btn-batchrename').disabled = false;
  }, true);

  $('#btn-batchrename').addEventListener('click', async () => {
    const files = st.files;
    if (!files || files.length === 0) return;

    const pattern = $('#pattern-batchrename').value.trim() || 'Document_{n}';
    
    const btn = $('#btn-batchrename');
    btn.disabled = true;
    hideResult('batchrename');
    setStatus('batchrename', 'Zipping files...', 'working');

    try {
      const zip = new window.JSZip();

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const origName = baseName(f.name);
        
        let newName = pattern
          .replace(/{n}/g, i + 1)
          .replace(/{orig}/g, origName);
          
        if (!newName.toLowerCase().endsWith('.pdf')) {
          newName += '.pdf';
        }

        zip.file(newName, f);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);

      const dlBtn = $('#dl-batchrename');
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Renamed_PDFs.zip';
        a.click();
      };

      $('#info-batchrename').textContent = `Renamed and zipped ${files.length} files.`;
      showResult('batchrename');
      setStatus('batchrename', '✅ Files renamed successfully!', 'success');

    } catch (e) {
      console.error(e);
      setStatus('batchrename', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
