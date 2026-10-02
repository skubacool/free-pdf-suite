import './app_monolith.js';
import { initPdfGrid } from './tools/pdfgrid.js';
import { initHeadFoot } from './tools/headfoot.js';
import { initBates } from './tools/bates.js';
import { initQRCode } from './tools/qrcode.js';
import { initTextDiff } from './tools/textdiff.js';
import { initBatchRename } from './tools/batchrename.js';
import { initHighlighter } from './tools/highlighter.js';
import { initBookmark } from './tools/bookmark.js';
import { initTableExtract } from './tools/tableextract.js';
import { initInvoice } from './tools/invoice.js';
import { initImageCollage } from './tools/imagecollage.js';
import { initMerge } from './tools/merge.js';
import { initSplit } from './tools/split.js';
import { initRotate } from './tools/rotate.js';
import { initSignTool } from './tools/sign.js';
import { initWorkspace } from './tools/workspace.js';
import { initHouseAds } from './tools/houseads.js';
import { initErase } from './tools/erase.js';
import { initEditText } from './tools/edittext.js';
import { initAnnotate } from './tools/annotate.js';
import { initFormCreate } from './tools/formcreate.js';
import { initCertSign } from './tools/certsign.js';
import { initFindRedact } from './tools/findredact.js';
import { initPdfA } from './tools/pdfa.js';
import * as officeExport from './tools/officeexport.js';
window.appOffice = officeExport;
import * as embeddedFont from './tools/embeddedfont.js';
window.appEmb = embeddedFont;

// Each tool module is isolated: one broken panel must not stop the rest.
const safe = (fn) => { try { fn(); } catch (e) { console.warn('[upmypdf] module skipped:', e && e.message); } };

document.addEventListener('DOMContentLoaded', () => {
  safe(() => initHouseAds());
  safe(() => initPdfGrid());
  safe(() => initHeadFoot());
  safe(() => initBates());
  safe(() => initQRCode());
  safe(() => initTextDiff());
  safe(() => initBatchRename());
  safe(() => initHighlighter());
  safe(() => initBookmark());
  safe(() => initTableExtract());
  safe(() => initInvoice());
  safe(() => initImageCollage());
  safe(() => initMerge());
  safe(() => initSplit());
  safe(() => initRotate());
  if (window.appHelpers) {
    safe(() => initSignTool(window.appHelpers));
    safe(() => initErase());
    safe(() => initEditText());
    safe(() => initAnnotate());
    safe(() => initFormCreate());
    safe(() => initCertSign());
    safe(() => initFindRedact());
    safe(() => initPdfA());
    safe(() => initWorkspace()); // after every tool has registered its dropzone
  }
});
