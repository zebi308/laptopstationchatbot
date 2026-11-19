// Shopify access. Products: Storefront API when SHOPIFY_STOREFRONT_TOKEN is set, otherwise the public catalogue.
// Orders: Admin API with either a static token or client-credentials (Dev Dashboard apps).
import * as publicCatalog from './public-catalog.js';
import { str, list } from './config.js';
import { enrich, addonRank } from './specs.js';

const env = () => process.env;

async function post(url, headers, query, variables) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(12_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) {
    console.error('[shopify] request failed', r.status, JSON.stringify(j.errors || j).slice(0, 500));
    throw Object.assign(new Error('Shopify request failed'), { status: r.status });
  }
  return j.data;
}

const storefront = (query, variables) => {
  const { SHOPIFY_STORE_DOMAIN: d, SHOPIFY_STOREFRONT_TOKEN: t, SHOPIFY_API_VERSION: v = '2026-07' } = env();
  if (!d || !t) throw new Error('Shopify Storefront API is not configured');
  return post(`https://${d}/api/${v}/graphql.json`, { 'X-Shopify-Storefront-Access-Token': t }, query, variables);
};

// ---- Admin API auth: static token (legacy custom app) OR client credentials (Dev Dashboard app, short-lived token)
let tokenCache = { token: null, exp: 0 };
export async function adminToken(force = false) {
  const { SHOPIFY_ADMIN_TOKEN: st, SHOPIFY_CLIENT_ID: id, SHOPIFY_CLIENT_SECRET: secret, SHOPIFY_STORE_DOMAIN: d } = env();
  if (st) return st;
  if (!id || !secret || !d) throw new Error('Order lookup is not configured');
  if (!force && tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const r = await fetch(str('SHOPIFY_ADMIN_TOKEN_URL', `https://${d}/admin/oauth/access_token`), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }), signal: AbortSignal.timeout(12_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { console.error('[shopify] token request failed', r.status); throw new Error('Shopify token request failed'); }
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86_399) * 1000 };
  return tokenCache.token;
}
export const resetAdminToken = () => { tokenCache = { token: null, exp: 0 }; };

export async function adminQuery(query, variables) {
  const { SHOPIFY_STORE_DOMAIN: d, SHOPIFY_API_VERSION: v = '2026-07' } = env();
  const go = async (force) => post(`https://${d}/admin/api/${v}/graphql.json`, { 'X-Shopify-Access-Token': await adminToken(force) }, query, variables);
  try { return await go(false); } catch (e) { if (e.status === 401 && !env().SHOPIFY_ADMIN_TOKEN) return go(true); throw e; }
}

// ---- Storefront product queries
// CONDITION_FIELDS="Overall=custom.condition;Screen=custom.screen_condition;Lid=custom.lid_condition" (label=namespace.key, ';' separated).
// A field labelled Overall (or Condition) becomes the headline condition; the rest are shown as parts. Each must be exposed to the Storefront API.
const condFields = () => str('CONDITION_FIELDS').split(';').map((x) => x.trim()).filter((x) => x.includes('=')).map((x) => {
  const [label, ref] = x.split('='); const [ns, key] = (ref || '').trim().split('.');
  return ns && key ? { label: label.trim(), ns: ns.replace(/[^\w-]/g, ''), key: key.replace(/[^\w-]/g, '') } : null;
}).filter(Boolean);
const condSelect = () => condFields().map((f, i) => `cf${i}: metafield(namespace: "${f.ns}", key: "${f.key}") { value }`).join('\n  ');
const metaCond = () => {
  const m = str('CONDITION_METAFIELD'); // e.g. custom.condition (must be exposed to the Storefront API)
  if (!m.includes('.')) return '';
  const [ns, key] = m.split('.').map((x) => x.replace(/[^\w-]/g, ''));
  return `cond: metafield(namespace: "${ns}", key: "${key}") { value }`;
};
const fragment = () => `
fragment P on Product {
  id handle title vendor productType description tags
  options { name values }
  featuredImage { url }
  ${metaCond()}
  ${condSelect()}
  variants(first: 30) { nodes {
    id title availableForSale ${env().SHOPIFY_INVENTORY_QTY === '1' ? 'quantityAvailable' : ''}
    selectedOptions { name value }
    price { amount currencyCode } compareAtPrice { amount }
  } }
}`;

export function highlights(text = '') {
  return String(text).split(/\n+|•|·|\s-\s|(?<=[.!?])\s/).map((s) => s.trim()).filter((s) => s.length >= 8 && s.length <= 110).slice(0, 3);
}

export function normalizeProduct(n) {
  const variants = n.variants.nodes.map((v) => ({
    id: String(v.id).split('/').pop(), title: v.title, price: Number(v.price.amount),
    compareAt: v.compareAtPrice && Number(v.compareAtPrice.amount) > Number(v.price.amount) ? Number(v.compareAtPrice.amount) : null,
    available: v.availableForSale, quantity: v.quantityAvailable ?? null,
    condition: (v.selectedOptions || []).find((o) => /condition|grade/i.test(o.name))?.value || null,
  }));
  const details = condFields().map((f, i) => ({ label: f.label, value: String(n[`cf${i}`]?.value || '').trim() })).filter((d) => d.value);
  const overall = details.find((d) => /^(overall|condition|grade)$/i.test(d.label));
  const parts = details.filter((d) => d !== overall);
  const product = enrich({
    handle: n.handle, title: n.title, url: `/products/${n.handle}`, image: n.featuredImage?.url || '', vendor: n.vendor, type: n.productType,
    tags: n.tags || [], description: (n.description || '').slice(0, 600), highlights: highlights(n.description),
    currency: n.variants.nodes[0]?.price.currencyCode || str('STORE_CURRENCY', 'GBP'), variants,
  }, { metafield: overall?.value || n.cond?.value });
  if (parts.length || overall) product.condition = { ...(product.condition || { label: overall?.value }), parts };
  return product;
}

async function sfSearch(q, limit = 5, f = {}) {
  const run = async (qs, n) => (await storefront(`query($q: String!, $n: Int!) { products(first: $n, query: $q, sortKey: RELEVANCE) { nodes { ...P } } } ${fragment()}`, { q: qs, n })).products.nodes.map(normalizeProduct);
  const clean = String(q || '').replace(/["():]/g, ' ').trim();
  const parts = [clean];
  if (Number.isFinite(f.maxPrice)) parts.push(`variants.price:<=${f.maxPrice}`);
  if (Number.isFinite(f.minPrice)) parts.push(`variants.price:>=${f.minPrice}`);
  if (f.inStock) parts.push('available_for_sale:true');
  const filtered = parts.length > 1;
  const n = Math.min(Math.max(filtered ? Math.max(limit, 100) : limit, 1), 100);
  let out = [];
  try { out = await run(parts.filter(Boolean).join(' '), n); } catch (e) { if (!filtered) throw e; }
  // If Shopify's filter syntax returned nothing, fall back to a wider plain search; tools.js filters the rest locally.
  if (!out.length && filtered) out = await run(clean, 100);
  return out;
}
async function sfGet(handle) {
  const data = await storefront(`query($h: String!) { product(handle: $h) { ...P } } ${fragment()}`, { h: handle });
  return data.product ? normalizeProduct(data.product) : null;
}
const useStorefront = () => Boolean(env().SHOPIFY_STOREFRONT_TOKEN && env().SHOPIFY_STORE_DOMAIN);
export const searchProducts = (q, limit, filters) => (useStorefront() ? sfSearch(q, limit, filters) : publicCatalog.searchProducts(q, limit));
export const getProduct = (handle) => (useStorefront() ? sfGet(handle) : publicCatalog.getProduct(handle));

export async function listAddonProducts() {
  if (!useStorefront()) return (await publicCatalog.listProducts()).filter((p) => p.isAddon);
  const types = list('ADDON_TYPES', 'software,service,services,accessory,accessories,add-on,addon,add-ons,protection,warranty').map((t) => `product_type:'${t.replace(/'/g, '')}'`);
  const tags = list('ADDON_TAGS', 'addon,add-on').map((t) => `tag:'${t.replace(/'/g, '')}'`);
  return (await sfSearch([...types, ...tags].join(' OR '), 40)).filter((p) => p.isAddon);
}

// Up to `limit` in-stock add-ons for a laptop (security/software first). Empty for add-on pages themselves.
export async function getAddons(handle, limit = 3) {
  const cur = await getProduct(handle);
  if (!cur || cur.isAddon) return [];
  return (await listAddonProducts()).filter((p) => p.variants.some((v) => v.available))
    .sort((a, b) => addonRank(a) - addonRank(b) || a.variants[0].price - b.variants[0].price).slice(0, limit);
}

// Order lookup. Only returns data when the order number AND the email on the order both match.
export async function lookupOrder(orderNumber, email) {
  const clean = String(orderNumber).replace(/^#/, '').trim();
  if (!/^[A-Za-z0-9-]{1,20}$/.test(clean) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return null;
  const data = await adminQuery(
    `query($q: String!) { orders(first: 3, query: $q) { nodes {
      name email createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 10) { nodes { title quantity } }
      fulfillments { displayStatus estimatedDeliveryAt trackingInfo { company number url } }
    } } }`, { q: `name:${clean}` });
  const o = data.orders.nodes.find((x) => x.name.replace(/^#/, '').toLowerCase() === clean.toLowerCase() && (x.email || '').toLowerCase() === email.trim().toLowerCase());
  if (!o) return null;
  return {
    order: o.name, placed: o.createdAt, cancelled: Boolean(o.cancelledAt), payment: o.displayFinancialStatus, fulfilment: o.displayFulfillmentStatus,
    total: `${o.currentTotalPriceSet.shopMoney.amount} ${o.currentTotalPriceSet.shopMoney.currencyCode}`, items: o.lineItems.nodes.map((i) => `${i.quantity} x ${i.title}`),
    shipments: o.fulfillments.map((f) => ({ status: f.displayStatus, estimatedDelivery: f.estimatedDeliveryAt, tracking: f.trackingInfo.map((t) => ({ carrier: t.company, number: t.number, url: t.url })) })),
  };
}
