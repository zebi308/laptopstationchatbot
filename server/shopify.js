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
  return enrich({
    handle: n.handle, title: n.title, url: `/products/${n.handle}`, image: n.featuredImage?.url || '', vendor: n.vendor, type: n.productType,
    tags: n.tags || [], description: (n.description || '').slice(0, 600), highlights: highlights(n.description),
    currency: n.variants.nodes[0]?.price.currencyCode || str('STORE_CURRENCY', 'GBP'), variants,
  }, { metafield: n.cond?.value });
}

async function sfSearch(q, limit = 5) {
  const data = await storefront(`query($q: String!, $n: Int!) { products(first: $n, query: $q, sortKey: RELEVANCE) { nodes { ...P } } } ${fragment()}`, { q, n: Math.min(Math.max(limit, 1), 40) });
  return data.products.nodes.map(normalizeProduct);
}
async function sfGet(handle) {
  const data = await storefront(`query($h: String!) { product(handle: $h) { ...P } } ${fragment()}`, { h: handle });
  return data.product ? normalizeProduct(data.product) : null;
}
const useStorefront = () => Boolean(env().SHOPIFY_STOREFRONT_TOKEN && env().SHOPIFY_STORE_DOMAIN);
export const searchProducts = (q, limit) => (useStorefront() ? sfSearch(q, limit) : publicCatalog.searchProducts(q, limit));
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
