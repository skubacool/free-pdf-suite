// Font matching for Edit PDF Text: the edit has to look like it was always
// there, so we want the PDF's OWN typeface, not a lookalike.
//
// A PDF normally embeds only a SUBSET of a font (just the glyphs it uses), so the
// embedded copy alone cannot spell new words. We build a CSS font stack that
// canvas resolves glyph by glyph:
//   1. the complete original family when we can get it: a locally installed font
//      (Arial, Tahoma, Calibri ...) or the same family from Google Fonts
//      (Sarabun, Noto Sans Thai, Kanit, Inter ...), at the right weight;
//   2. the subset face pdf.js already loaded for this PDF (exact design for every
//      glyph the document already used);
//   3. a generic stack of the same style, as a last resort.
const FACE_CACHE = new Map(); // key -> Promise<string|null>  (family name, or null if unavailable)
const SYSTEM = new Set(['arial', 'helvetica', 'times new roman', 'times', 'courier new', 'courier', 'tahoma', 'calibri', 'cambria', 'verdana', 'georgia', 'segoe ui', 'consolas', 'trebuchet ms', 'impact', 'comic sans ms', 'cordia new', 'angsana new', 'browallia new', 'leelawadee ui', 'leelawadee', 'microsoft sans serif', 'symbol', 'garamond', 'palatino linotype', 'book antiqua', 'lucida sans unicode', 'arial narrow', 'franklin gothic medium', 'century gothic', 'gill sans mt', 'candara', 'corbel', 'constantia', 'dilleniaupc', 'angsana upc', 'cordia upc', 'browallia upc', 'eucrosia upc', 'freesia upc', 'iris upc', 'jasmine upc', 'kodchiang upc', 'lilyupc', 'mangal', 'dauphin']);
const ALIAS = { 'helvetica': 'Arial', 'arialmt': 'Arial', 'times': 'Times New Roman', 'timesnewromanps': 'Times New Roman', 'courier': 'Courier New', 'th sarabun new': 'Sarabun', 'th sarabun psk': 'Sarabun', 'th sarabunpsk': 'Sarabun', 'thsarabunnew': 'Sarabun', 'thsarabunpsk': 'Sarabun', 'thsarabun': 'Sarabun' };
const GENERIC = {
  sans: 'Arial,Helvetica,"Sarabun","Noto Sans Thai","Segoe UI",sans-serif',
  serif: '"Times New Roman",Times,"Noto Serif Thai","Noto Sans Thai",serif',
  mono: '"Courier New",Courier,monospace',
};
const WEIGHTS = [['thin', 100], ['extralight', 200], ['ultralight', 200], ['light', 300], ['regular', 400], ['normal', 400], ['book', 400], ['medium', 500], ['semibold', 600], ['demibold', 600], ['bold', 700], ['extrabold', 800], ['heavy', 800], ['black', 900]];
const WNAME = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

// "ABCDEF+Sarabun-Bold" -> { family:'Sarabun', weight:700, italic:false, mono, serif }
export function parseFontName(raw) {
  const name = String(raw || '').replace(/^[A-Z]{6}\+/, '');
  const parts = name.split(/[-,]/);
  let fam = parts[0].replace(/(PSMT|MT|PS)$/, '');
  const style = parts.slice(1).join(' ').toLowerCase() + ' ' + (/(Bold|Italic|Oblique|Black|Light|Medium)$/.exec(fam) ? fam.toLowerCase() : '');
  fam = fam.replace(/(Bold|Italic|Oblique)+$/, '');
  const pretty = fam.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').trim();
  let weight = 400;
  for (const [k, v] of WEIGHTS) if (style.includes(k)) weight = Math.max(weight === 400 ? 0 : weight, v);
  if (/bold/.test(style) && weight < 700) weight = 700;
  return {
    family: pretty || 'Arial',
    weight,
    italic: /italic|oblique/.test(style),
    mono: /mono|courier|consolas|menlo/i.test(name),
    serif: /(times|serif|georgia|garamond|minion|cambria|palatino|bookman|merriweather|playfair|lora)/i.test(name) && !/sans/i.test(name),
  };
}

const widthOf = (family, text) => {
  const c = widthOf.c || (widthOf.c = document.createElement('canvas').getContext('2d'));
  c.font = `72px ${family}`;
  return c.measureText(text).width;
};
export function isInstalled(family) {
  const t = 'mmmmmmmmmmlliWWW@@ ก้ำ';
  const q = `"${family}"`;
  return ['monospace', 'serif', 'sans-serif'].some((g) => Math.abs(widthOf(`${q},${g}`, t) - widthOf(g, t)) > 0.5);
}

// raw bytes of a Google font (via the @expo-google-fonts packages on jsDelivr), or null
export async function googleFontBytes(family, weight, italic) {
  const pascal = family.replace(/[^A-Za-z0-9]/g, '');
  const pkg = family.replace(/\s+/g, '-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9-]/g, '');
  for (const w of [weight, weight >= 600 ? 700 : 400]) {
    const file = `${pascal}_${w}${WNAME[w]}${italic ? '_Italic' : ''}.ttf`;
    for (const url of [`https://cdn.jsdelivr.net/npm/@expo-google-fonts/${pkg}/${file}`, `https://cdn.jsdelivr.net/npm/@expo-google-fonts/${pkg}/${w}${WNAME[w]}${italic ? '_Italic' : ''}/${file}`]) {
      try { const res = await fetch(url); if (res.ok) return await res.arrayBuffer(); } catch (_) { /* next */ }
    }
  }
  return null;
}

async function loadGoogle(family, weight, italic) {
  const key = `${family}|${weight}|${italic}`;
  if (FACE_CACHE.has(key)) return FACE_CACHE.get(key);
  const p = (async () => {
    const pascal = family.replace(/[^A-Za-z0-9]/g, '');
    const pkg = family.replace(/\s+/g, '-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const tryWeights = [weight, weight >= 600 ? 700 : 400];
    for (const w of tryWeights) {
      const file = `${pascal}_${w}${WNAME[w]}${italic ? '_Italic' : ''}.ttf`;
      for (const url of [`https://cdn.jsdelivr.net/npm/@expo-google-fonts/${pkg}/${file}`, `https://cdn.jsdelivr.net/npm/@expo-google-fonts/${pkg}/${w}${WNAME[w]}${italic ? '_Italic' : ''}/${file}`]) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const face = new FontFace(`upm_${pascal}_${w}${italic ? 'i' : ''}`, await res.arrayBuffer(), { weight: String(w), style: italic ? 'italic' : 'normal' });
          await face.load();
          document.fonts.add(face);
          return { family: face.family, weight: w };
        } catch (_) { /* try next */ }
      }
    }
    return null;
  })();
  FACE_CACHE.set(key, p);
  return p;
}

// Returns { font(sizePx) -> CSS font shorthand, info }. `want` may override
// weight (bold toggle) or force a generic family ('sans'|'serif'|'mono').
export async function resolveFont(page, fontName, want = {}) {
  let raw = '', loaded = '';
  try { const f = page.commonObjs.get(fontName); raw = f.name || ''; loaded = f.loadedName || fontName; } catch (_) { loaded = fontName; }
  const p = parseFontName(raw);
  const forced = want.family && want.family !== 'orig' ? want.family : null;
  const generic = forced ? GENERIC[forced] : p.mono ? GENERIC.mono : p.serif ? GENERIC.serif : GENERIC.sans;
  const weight = want.bold == null ? p.weight : want.bold ? Math.max(700, p.weight) : Math.min(400, p.weight);
  const italic = p.italic;
  const stack = [];
  let usedWeight = null; // weight baked into a loaded Google face
  let full = false;      // a complete (not subset) copy of the family is in the stack
  if (!forced) {
    const alias = ALIAS[p.family.toLowerCase()] || p.family;
    const known = SYSTEM.has(alias.toLowerCase());
    if (isInstalled(alias)) { stack.push(`"${alias}"`); full = true; }
    if (!known) {
      const g = await loadGoogle(alias, weight, italic);
      if (g) { stack.unshift(`"${g.family}"`); usedWeight = g.weight; full = true; }
    }
    if (loaded) stack.push(`"${loaded}"`); // the subset pdf.js loaded for this PDF
  }
  // A subset face is already the right weight; asking for bold on top of it would
  // double-embolden. Only request a weight when a complete face can honour it, or
  // when the user changed bold on/off.
  const toggled = want.bold != null && want.bold !== (p.weight >= 600);
  const cssWeight = usedWeight || (full ? (weight >= 600 ? 700 : 400) : toggled ? (want.bold ? 700 : 400) : 400);
  return {
    info: { family: p.family, weight: cssWeight, italic, viaGoogle: usedWeight != null, system: full && usedWeight == null, hasSubset: !!loaded },
    font: (px) => `${italic ? 'italic ' : ''}${cssWeight} ${px}px ${stack.length ? stack.join(',') + ',' : ''}${generic}`,
  };
}
