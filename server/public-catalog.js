// Token-free catalogue: reads the store's public /products.json (works on any public Shopify store),
// caches it in memory and searches it locally. Used when SHOPIFY_STOREFRONT_TOKEN is not set.
import { enrich } from './specs.js';

const ttl = () => Number(process.env.CATALOG_TTL_SECONDS || 120) * 1000;
const base = () => (process.env.SHOPIFY_PUBLIC_URL || `https://${process.env.SHOPIFY_STORE_DOMAIN || ''}`).replace(/\/$/, '');

let cache = { at: 0, items: [], byHandle: new Map() };
let inflight = null;

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
export const htmlToText = (html = '') =>
  decode(String(html).replace(/<\s*br\s*\/?>|<\/(p|li|div|h\d|ul|ol)>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*/g, '\n').trim();

// Prefer "- bullet" lines (typical for spec lists); fall back to the first short lines.
export function highlightsFromText(text = '') {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^[-•·*]\s*/.test(l)).map((l) => l.replace(/^[-•·*]\s*/, ''));
  const pool = (bullets.length ? bullets : lines).filter((l) => l.length >= 8 && !/^key features:?$/i.test(l));
  return pool.slice(0, 3).map((l) => (l.length > 100 ? l.slice(0, 97).replace(/\s+\S*$/, '') + '…' : l));
}

const stockNote = (t) =>
  ((t.match(/[^.\n]*\b(only\s+(one|two|three|\d+)\s+(available|left|in stock)|limited stock|last (one|unit))\b[^.\n]*/i) || [])[0] || '').trim() || null;

function index(p) {
  const text = htmlToText(p.body_html);
  const tags = (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',')).map((t) => t.trim()).filter(Boolean);
  const product = {
    handle: p.handle,
    title: p.title,
    url: `/products/${p.handle}`,
    image: (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || '',
    vendor: p.vendor || '',
    type: p.product_type || '',
    description: text.slice(0, 600),
    stockNote: stockNote(text),
    highlights: highlightsFromText(text),
    currency: process.env.STORE_CURRENCY || 'GBP',
    variants: (p.variants || []).map((v) => ({
      id: String(v.id),
      title: v.title,
      price: Number(v.price),
      compareAt: v.compare_at_price && Number(v.compare_at_price) > Number(v.price) ? Number(v.compare_at_price) : null,
      available: v.available !== false,
      quantity: null,
    })),
  };
  product.tags = tags;
  const ci = (p.options || []).findIndex((o) => /condition|grade/i.test(o.name));
  if (ci >= 0) product.variants.forEach((v, i) => { v.condition = (p.variants[i] || {})[`option${ci + 1}`] || null; });
  enrich(product);
  if (!product.variants.some((v) => v.available)) product.stockNote = null;
  const lc = (s) => String(s || '').toLowerCase();
  return { p: product, hay: { title: lc(p.title), vendor: lc(p.vendor), meta: lc(`${p.product_type} ${tags.join(' ')}`), body: lc(text) } };
}

async function load(force = false) {
  if (!force && cache.items.length && Date.now() - cache.at < ttl()) return cache;
  inflight ??= (async () => {
    try {
      const items = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(`${base()}/products.json?limit=250&page=${page}`, {
          headers: { 'User-Agent': 'LaptopStationChat/1.0', Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !Array.isArray(j.products)) throw new Error(`Catalogue fetch failed (${r.status})`);
        j.products.forEach((p) => items.push(index(p)));
        if (j.products.length < 250) break;
      }
      cache = { at: Date.now(), items, byHandle: new Map(items.map((i) => [i.p.handle, i.p])) };
      return cache;
    } catch (e) {
      console.error('[catalogue]', e.message);
      if (cache.items.length) return cache; // serve stale data rather than fail
      throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const STOP = new Set(['a', 'an', 'the', 'for', 'with', 'under', 'over', 'below', 'above', 'and', 'or', 'in', 'to', 'of', 'me', 'my', 'best', 'good', 'cheap', 'cheapest', 'new', 'some', 'any', 'show', 'gbp']);
const LOW = new Set(['laptop', 'laptops', 'notebook', 'notebooks']); // matches nearly everything, so weight lightly

export async function searchProducts(q, limit = 5) {
  const { items } = await load();
  const tokens = (String(q).toLowerCase().match(/[a-z0-9.]+/g) || []).map((t) => t.replace(/^\.+|\.+$/g, '')).filter((t) => t && !STOP.has(t));
  const scored = items
    .map(({ p, hay }) => {
      let s = 0;
      for (const t of tokens) {
        const w = LOW.has(t) ? 0.25 : 1;
        if (hay.title.includes(t)) s += 3 * w;
        else if (hay.vendor.includes(t)) s += 2 * w;
        else if (hay.meta.includes(t)) s += 1 * w;
        else if (hay.body.includes(t)) s += 0.5 * w;
      }
      return { p, s };
    })
    .filter((x) => !tokens.length || x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.p);
}

export async function getProduct(handle) {
  let c = await load();
  let p = c.byHandle.get(handle);
  if (!p) { c = await load(true); p = c.byHandle.get(handle); }
  return p || null;
}

export async function listProducts() { return (await load()).items.map((i) => i.p); }

export async function catalogStatus() {
  const out = { source: base() + '/products.json', ttlSeconds: ttl() / 1000 };
  try {
    const r = await fetch(`${base()}/products.json?limit=250&page=1`, { headers: { 'User-Agent': 'LaptopStationChat/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    out.httpStatus = r.status;
    const j = await r.json().catch(() => null);
    out.firstPageProducts = j && Array.isArray(j.products) ? j.products.length : null;
    if (!r.ok) out.bodyStart = (await r.text().catch(() => '')).slice(0, 120);
    const c = await load(true);
    out.indexed = c.items.length;
    out.asus = c.items.filter((i) => /asus/i.test(i.p.vendor + i.p.title)).length;
    out.asusUnder600InStock = c.items.filter((i) => !i.p.isAddon && /asus/i.test(i.p.title + i.p.vendor) && i.p.variants.some((v) => v.available) && Math.min(...i.p.variants.map((v) => v.price)) <= 600).length;
  } catch (e) { out.error = e.message; }
  return out;
}