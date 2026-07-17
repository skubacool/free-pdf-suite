export function initTextDiff() {
  const { $, hideResult, showResult, setStatus } = window.appHelpers;

  const st = { file1: null, file2: null };
  const dz1 = $('#dz-textdiff-1');
  const dz2 = $('#dz-textdiff-2');
  if (!dz1 || !dz2) return;

  // Custom setup for two dropzones
  const setupDz = (dzId, fileKey, pickedId) => {
    const el = $(dzId);
    const inp = el.querySelector('input[type="file"]');
    
    el.addEventListener('click', () => inp.click());
    
    const handleFiles = (files) => {
      if (files.length > 0) {
        st[fileKey] = files[0];
        $(pickedId).textContent = `Loaded: ${files[0].name}`;
        checkReady();
      }
    };
    
    inp.addEventListener('change', (e) => handleFiles(e.target.files));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });
  };

  setupDz('#dz-textdiff-1', 'file1', '#picked-textdiff-1');
  setupDz('#dz-textdiff-2', 'file2', '#picked-textdiff-2');

  const btn = $('#btn-textdiff');
  
  function checkReady() {
    if (st.file1 && st.file2) {
      btn.disabled = false;
    }
  }

  // Load Diff lib
  const loadDiffLib = () => new Promise((resolve) => {
    if (window.Diff) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/diff@5.2.0/dist/diff.min.js';
    script.onload = resolve;
    document.head.appendChild(script);
  });

  const extractPdfText = async (file) => {
    const arr = new Uint8Array(await file.arrayBuffer());
    const loadingTask = window.pdfjsLib.getDocument({ data: arr });
    const pdf = await loadingTask.promise;
    let fullText = '';
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      // Simple heuristic to add newlines where they make sense
      fullText += pageText.replace(/  +/g, '\n') + '\n\n';
    }
    return fullText;
  };

  btn.addEventListener('click', async () => {
    if (!st.file1 || !st.file2) return;

    btn.disabled = true;
    hideResult('textdiff');
    setStatus('textdiff', 'Extracting text and comparing...', 'working');

    try {
      await loadDiffLib();
      
      const [text1, text2] = await Promise.all([
        extractPdfText(st.file1),
        extractPdfText(st.file2)
      ]);

      const diff = window.Diff.diffWords(text1, text2);
      
      const resContainer = $('#preview-result-textdiff');
      resContainer.innerHTML = '';
      
      const fragment = document.createDocumentFragment();
      
      diff.forEach((part) => {
        const span = document.createElement('span');
        span.textContent = part.value;
        if (part.added) {
          span.style.backgroundColor = '#dcfce7'; // green-100
          span.style.color = '#166534'; // green-800
          span.style.fontWeight = 'bold';
        } else if (part.removed) {
          span.style.backgroundColor = '#fee2e2'; // red-100
          span.style.color = '#991b1b'; // red-800
          span.style.textDecoration = 'line-through';
        }
        fragment.appendChild(span);
      });
      
      resContainer.appendChild(fragment);

      showResult('textdiff');
      setStatus('textdiff', '✅ Comparison complete.', 'success');

    } catch (e) {
      console.error(e);
      setStatus('textdiff', `❌ Error: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}
