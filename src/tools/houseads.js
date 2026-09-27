// House ads: our own companies in the site's reserved ad slots (until/unless
// a network like AdSense takes over). Creatives are generated in one place
// (gen_ads.py -> assets/house-ads/*.html) and imported raw here, so the
// markup on the site is exactly what was reviewed.
//   - English and other non-Thai pages: House of Software
//   - Thai pages (<html lang="th">):   Power Express
// Slots filled: the desktop sidebar (.ad-frame-side) and the inline slot that
// sits under a tool's Download button (.ad-frame-inline, only visible once a
// result exists). The top slot (.ad-frame-top) lives inside the sticky site
// header, so it stays hidden: a pinned banner would eat the viewport.
import css from '../../assets/house-ads/house-ads.css.html?raw';
import hosSide from '../../assets/house-ads/hos-sidebar.html?raw';
import hosInline from '../../assets/house-ads/hos-inline.html?raw';
import pexSide from '../../assets/house-ads/pex-sidebar.html?raw';
import pexInline from '../../assets/house-ads/pex-inline.html?raw';

// Inline creative rotates between real case-study screenshots.
const HOS_SHOTS = [
  ['ad-thai-rent-a-car.jpg', 'Thai Rent A Car booking site'],
  ['ad-sf-cinema.jpg', 'SF Cinema booking platform'],
  ['ad-kiatnakin.jpg', 'Kiatnakin Phatra Wealth site'],
];

export function initHouseAds() {
  if (document.body.dataset.ads !== 'on') return;
  const slots = document.querySelectorAll('.ad-box.ad-frame-side, .ad-box.ad-frame-inline');
  if (!slots.length) return;

  // Asset base = the folder app.js is served from, so paths work both at the
  // site root and under a local sub-folder preview.
  const app = document.querySelector('script[src*="app.js"]');
  const base = app ? new URL('.', app.src).href : '/';
  const fix = (html) => html.replaceAll('/assets/house-ads/', base + 'assets/house-ads/');

  const thai = (document.documentElement.lang || '').toLowerCase().startsWith('th');
  let side = thai ? pexSide : hosSide;
  let inline = thai ? pexInline : hosInline;
  if (!thai) {
    const [img, alt] = HOS_SHOTS[Math.floor(Math.random() * HOS_SHOTS.length)];
    inline = inline.replace(/ad-thai-rent-a-car\.jpg" alt="[^"]*"/, `${img}" alt="${alt}"`);
  }

  document.head.insertAdjacentHTML('beforeend', css + `
<style>
.ad-box.has-ha{padding-top:22px;overflow:hidden;}
.ad-box.has-ha .hsa.side{width:100%;}
.ad-box.has-ha .hsa{border-radius:0 0 11px 11px;}
/* The editors keep their panels clean: no inline ad under each applied step. */
.ws-step .ad-box.ad-frame-inline{display:none!important;}
</style>`);

  slots.forEach((slot) => {
    const isSide = slot.classList.contains('ad-frame-side');
    slot.innerHTML = fix(isSide ? side : inline);
    slot.classList.add('has-ha');
  });
}
