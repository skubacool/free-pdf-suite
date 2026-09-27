// House ads: our own companies in the site's reserved ad slots (until/unless
// a network like AdSense takes over). Creatives are generated in one place
// (gen_ads.py -> assets/house-ads/<set>-<slot>.html) and imported raw here, so
// the markup on the site is exactly what was reviewed.
//
// Rotation: one brand per page view, alternating through the visit
// (House of Software, Power Express, House of Software, ...), starting at
// random. Power Express uses its Thai creatives on Thai pages, English
// elsewhere. No client names or client screenshots.
//
// Slots filled:
//   every page  #ad-header       banner, right below the header (not sticky -
//                                the slot was moved out of <header> so it
//                                scrolls with the page instead of staying
//                                pinned)
//   tool pages  .ad-frame-side   desktop sidebar 300x600
//               .ad-frame-inline under a tool's Download button (shown only
//                                once a result exists)
//   home page   #home-view .ad-box (not #ad-home)  native card in the tool grid
//               #ad-home                           banner below the tool grid
// The page CSS hides every .ad-box that has no house ad in it, so a page
// missing one of these slots (a lean single-tool page, say) is unaffected.
import css from '../../assets/house-ads/house-ads.css.html?raw';

const files = import.meta.glob('../../assets/house-ads/*-*.html', { query: '?raw', import: 'default', eager: true });
const creative = (set, slot) => files[`../../assets/house-ads/${set}-${slot}.html`] || '';

const KEY = 'upmypdf_ad_turn';
const pickBrand = () => {
  let n = 0;
  try { n = parseInt(sessionStorage.getItem(KEY), 10) || 0; } catch (_) {}
  if (!n) n = 1 + Math.floor(Math.random() * 2);
  try { sessionStorage.setItem(KEY, String(n + 1)); } catch (_) {}
  return n % 2 ? 'hos' : 'pex';
};

export function initHouseAds() {
  if (document.body.dataset.ads !== 'on') return;
  const home = document.getElementById('home-view');
  const slots = [
    ...[...document.querySelectorAll('#ad-header.ad-box')].map((el) => [el, 'banner']),
    ...[...document.querySelectorAll('.ad-box.ad-frame-side')].map((el) => [el, 'sidebar']),
    ...[...document.querySelectorAll('.ad-box.ad-frame-inline')].map((el) => [el, 'inline']),
    ...(home ? [...home.querySelectorAll('.ad-box')].filter((el) => el.id !== 'ad-home' && !el.classList.contains('ad-frame-inline')).map((el) => [el, 'card']) : []),
    ...[...document.querySelectorAll('#ad-home.ad-box')].map((el) => [el, 'banner']),
  ];
  if (!slots.length) return;

  // Asset base = the folder app.js is served from, so paths work both at the
  // site root and under a local sub-folder preview.
  const app = document.querySelector('script[src*="app.js"]');
  const base = app ? new URL('.', app.src).href : '/';
  const fix = (html) => html.replaceAll('/assets/house-ads/', base + 'assets/house-ads/');

  const thai = (document.documentElement.lang || '').toLowerCase().startsWith('th');
  const brand = pickBrand();
  const set = brand === 'hos' ? 'hos' : thai ? 'pex-th' : 'pex-en';

  document.head.insertAdjacentHTML('beforeend', css + `
<style>
.ad-box.has-ha{padding-top:22px;overflow:hidden;}
.ad-box.has-ha .hsa.side{width:100%;}
.ad-box.has-ha .hsa{border-radius:0 0 11px 11px;}
/* home grid card: carries its own "Ad" chip, so no frame label or top padding */
.ad-box.has-ha.ha-card{padding-top:0;background:#fff;}
.ad-box.has-ha.ha-card::before{display:none;}
.ad-box.has-ha.ha-card .hsa{border-radius:16px;}
#ad-home.has-ha,#ad-header.has-ha{height:auto;min-height:100px;}
/* The editors keep their panels clean: no inline ad under each applied step. */
.ws-step .ad-box.ad-frame-inline{display:none!important;}
</style>`);

  slots.forEach(([el, slot]) => {
    const html = creative(set, slot);
    if (!html) return;
    el.innerHTML = fix(html);
    el.classList.add('has-ha');
    if (slot === 'card') el.classList.add('ha-card');
  });
}
