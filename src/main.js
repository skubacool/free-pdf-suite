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

document.addEventListener('DOMContentLoaded', () => {
  initPdfGrid();
  initHeadFoot();
  initBates();
  initQRCode();
  initTextDiff();
  initBatchRename();
  initHighlighter();
  initBookmark();
  initTableExtract();
  initInvoice();
  initImageCollage();
  initMerge();
  initSplit();
  initRotate();
  if (window.appHelpers) {
    initSignTool(window.appHelpers);
  }
});
