// Derived product data: specs parsed from titles, condition/grade detection, add-on detection.
import { list } from './config.js';
const n = (s) => Number(String(s).replace(',', '.'));

export function parseSpecs(title = '') {
  const t = String(title).replace(/[“”]/g, '"');
  const s = {};
  let m;
  if ((m = t.match(/\b(Intel|AMD|Apple|Qualcomm|Snapdragon|MediaTek)\b.+?(?=\s\d{1,3}\s?GB\b)/i))) s.cpu = m[0].trim();
  if ((m = t.match(/(\d{1,3})\s?GB\s+(?:(?:LP)?DDR\d\w*\s+)?RAM/i))) s.ramGb = n(m[1]);
  if ((m = t.match(/(\d+(?:\.\d+)?)\s?(GB|TB)\s+(SSD|HDD|eMMC|NVMe|SSHD)/i))) {
    s.storageGb = Math.round(n(m[1]) * (/tb/i.test(m[2]) ? 1000 : 1));
    s.storageText = `${m[1]}${m[2].toUpperCase()} ${/emmc/i.test(m[3]) ? 'eMMC' : m[3].toUpperCase()}`;
  }
  if ((m = t.match(/(\d{2}(?:\.\d)?)\s?(?:"|inch\b|''|in\b)/i))) s.screenIn = n(m[1]);
  if ((m = t.match(/Windows\s?1[01](?:\s?(?:Home|Pro))?|Chrome\s?OS|macOS|Linux/i))) s.os = m[0].replace(/Chrome\s?OS/i, 'ChromeOS');
  s.chips = [s.cpu, s.ramGb && `${s.ramGb}GB RAM`, s.storageText, s.screenIn && `${s.screenIn}"`, s.os].filter(Boolean);
  return s;
}

const GRADE_WORDS = /^(brand new|new|like new|refurbished|renewed|excellent|very good|good|fair|pre-?owned|used|open box|grade\s*[a-d]\+?)$/i;
const cap = (s) => String(s).trim().replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Order of trust: metafield > tag > title > description. (Per-variant option values are set by the catalogue code.)
export function detectCondition({ title = '', tags = [], description = '', metafield } = {}) {
  if (metafield && String(metafield).trim()) return { label: cap(metafield), source: 'metafield' };
  for (const t of tags) { // specific first: "Condition: X", "Grade A"
    const m = String(t).match(/^(?:condition|grade)\s*[:\-]\s*(.+)$/i);
    if (m) return { label: cap(m[1]), source: 'tag' };
    if (/^grade\s*[a-d]\+?$/i.test(String(t).trim())) return { label: cap(t), source: 'tag' };
  }
  for (const t of tags) if (GRADE_WORDS.test(String(t).trim())) return { label: cap(t), source: 'tag' }; // then generic: "Refurbished", "Like new"
  const m = String(title).match(/\b(brand new|like new|refurbished|renewed|pre-?owned|open box|grade\s*[a-d]\+?)\b/i);
  if (m) return { label: cap(m[1].toLowerCase().replace(/^grade/, 'Grade')), source: 'title' };
  const d = String(description).match(/\bin (?:an? )?(fantastic|excellent|great|good|perfect|pristine|immaculate)(?: working)? condition\b/i);
  if (d) return { label: `${cap(d[1])} condition`, source: 'description' };
  return null;
}

export function isAddon({ type = '', tags = [] } = {}) {
  const types = list('ADDON_TYPES', 'software,service,services,accessory,accessories,add-on,addon,add-ons,protection,warranty').map((s) => s.toLowerCase());
  const atags = list('ADDON_TAGS', 'addon,add-on').map((s) => s.toLowerCase());
  return types.includes(String(type).toLowerCase()) || tags.some((t) => atags.includes(String(t).toLowerCase()));
}

// Adds specs / condition / isAddon to a canonical product (mutates and returns it).
export function enrich(p, { metafield } = {}) {
  p.specs = parseSpecs(p.title);
  p.isAddon = isAddon({ type: p.type, tags: p.tags || [] });
  p.condition = detectCondition({ title: p.title, tags: p.tags || [], description: p.description, metafield });
  return p;
}

// Rank add-ons: security/software first, then upgrades, then accessories (override with ADDON_PRIORITY).
export function addonRank(p) {
  const order = list('ADDON_PRIORITY', 'antivirus,norton,office,microsoft,protection,warranty,setup,upgrade,bag,mouse');
  const hay = `${p.title} ${p.type}`.toLowerCase();
  const i = order.findIndex((k) => hay.includes(k.toLowerCase()));
  return i < 0 ? order.length : i;
}
