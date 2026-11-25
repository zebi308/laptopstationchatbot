import { searchProducts, getProduct, lookupOrder, listAddonProducts } from './shopify.js';
import { searchKb, kbStats } from './kb/search.js';
import { hoursStatus } from './hours.js';
import { str, num } from './config.js';

export const TOOLS = [
  {
    name: 'search_products',
    description: 'Search the store catalogue. Returns live titles, prices, variants, availability, specs and condition grade. Use short keyword queries (brand, model). Use the filters for budgets, RAM, storage, screen size, OS and condition, and sort for "cheapest". By default only main products are returned: set kind="addon" for software, warranties, upgrades and accessories.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 8 },
        kind: { type: 'string', enum: ['main', 'addon', 'any'] },
        max_price: { type: 'number', description: 'Maximum price in the store currency' }, min_price: { type: 'number' },
        min_ram_gb: { type: 'number' }, min_storage_gb: { type: 'number', description: '1TB = 1000' },
        min_screen_in: { type: 'number' }, max_screen_in: { type: 'number' },
        os: { type: 'string', description: 'e.g. Windows 11, ChromeOS' }, condition: { type: 'string', description: 'e.g. Brand new, Grade A, Refurbished' },
        in_stock_only: { type: 'boolean', description: 'Defaults to true (sold-out items hidden). Set false only if the shopper explicitly asks about sold-out items.' },
        sort: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc'] },
      },
      required: ['query'],
    },
  },
  { name: 'get_product', description: 'Get live details for one product by its handle (variants, prices, availability).', input_schema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] } },
  {
    name: 'show_product_cards',
    description: 'Show product cards (image, specs, condition, price, stock, Add to cart / Buy now buttons) to the shopper. Call this after recommending products. Max 3 handles.',
    input_schema: { type: 'object', properties: { handles: { type: 'array', items: { type: 'string' }, maxItems: 3 } }, required: ['handles'] },
  },
  {
    name: 'cart_action',
    description: "Add a variant to the shopper's cart, or send them straight to checkout. Only use when the shopper has clearly asked for it and the variant is known.",
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['add', 'buy_now'] }, variant_id: { type: 'string', description: 'Numeric variant id from search_products / get_product / page context' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['action', 'variant_id'],
    },
  },
  {
    name: 'lookup_order',
    description: 'Look up an order status. Requires BOTH the order number and the email address used on the order. Never guess either.',
    input_schema: { type: 'object', properties: { order_number: { type: 'string' }, email: { type: 'string' } }, required: ['order_number', 'email'] },
  },
  {
    name: 'search_knowledge',
    description: 'Search Laptop Station\'s own information (policies, delivery, warranty, returns, finance such as Klarna/ClearPay, condition grades, setup and upgrade services, FAQs). Use this for EVERY policy or "how does it work" question and answer only from the results.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'request_human',
    description: 'Show the shopper a contact form so a team member can follow up. Use when the shopper asks for a person, wants a quote, setup or upgrade help, or you cannot answer from your tools. It does not send anything by itself: the shopper fills in and submits the form.',
    input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'What the shopper needs, in one sentence' }, kind: { type: 'string', enum: ['human', 'enquiry'] } }, required: ['reason'] },
  },
];

export const STATUS = {
  search_products: 'Searching products…', get_product: 'Checking availability…', show_product_cards: 'Preparing options…',
  cart_action: 'Updating your cart…', lookup_order: 'Looking up your order…', search_knowledge: 'Checking our information…', request_human: 'Preparing a contact form…',
};

const forModel = (p) => ({
  handle: p.handle, title: p.title, vendor: p.vendor, type: p.type, description: p.description,
  condition: p.condition?.label, condition_parts: p.condition?.parts?.length ? p.condition.parts : undefined, specs: p.specs && { cpu: p.specs.cpu, ram_gb: p.specs.ramGb, storage: p.specs.storageText, screen_in: p.specs.screenIn, os: p.specs.os },
  is_addon: p.isAddon || undefined, stock_note: p.stockNote || undefined, currency: p.currency,
  variants: p.variants.map((v) => ({ variant_id: v.id, title: v.title, price: v.price, compare_at: v.compareAt, available: v.available, quantity: v.quantity, condition: v.condition || undefined })),
});

// Per-order brute-force guard: too many failed lookups for one order number locks it for a while (same message either way).
const fails = new Map();
const orderKey = (n) => String(n).replace(/^#/, '').trim().toLowerCase();
const locked = (k) => { const w = num('ORDER_FAIL_WINDOW_MIN', 60) * 60_000, now = Date.now(); const a = (fails.get(k) || []).filter((t) => now - t < w); fails.set(k, a); return a.length >= num('ORDER_MAX_FAILS', 5); };
export const resetOrderLimiter = () => fails.clear();
const NOT_FOUND = { error: 'No order found for that order number and email. Ask the shopper to double-check both.' };

export async function runTool(name, input, ctx) {
  ctx.tools?.push(name);
  const cached = async (handle) => (ctx.cache[handle] ??= await getProduct(handle));
  try {
    switch (name) {
      case 'search_products': {
        const kind = input.kind || 'main', q = String(input.query || '').slice(0, 120);
        let items = await searchProducts(q, 60, { maxPrice: input.max_price, minPrice: input.min_price, inStock: input.in_stock_only !== false && kind !== 'addon', excludeAddons: kind === 'main' });
        if (kind === 'addon' && (!items.some((p) => p.isAddon) || !q.trim() || q.trim() === '*')) items = await listAddonProducts();
        if (kind === 'main') items = items.filter((p) => !p.isAddon); else if (kind === 'addon') items = items.filter((p) => p.isAddon);
        const low = (p) => Math.min(...p.variants.map((v) => v.price));
        const sp = (p, k) => p.specs?.[k] ?? null;
        if (typeof input.max_price === 'number') items = items.filter((p) => low(p) <= input.max_price);
        if (typeof input.min_price === 'number') items = items.filter((p) => low(p) >= input.min_price);
        if (typeof input.min_ram_gb === 'number') items = items.filter((p) => (sp(p, 'ramGb') ?? -1) >= input.min_ram_gb);
        if (typeof input.min_storage_gb === 'number') items = items.filter((p) => (sp(p, 'storageGb') ?? -1) >= input.min_storage_gb);
        if (typeof input.min_screen_in === 'number') items = items.filter((p) => (sp(p, 'screenIn') ?? -1) >= input.min_screen_in);
        if (typeof input.max_screen_in === 'number') items = items.filter((p) => (sp(p, 'screenIn') ?? 99) <= input.max_screen_in);
        if (input.os) items = items.filter((p) => (sp(p, 'os') || '').toLowerCase().includes(String(input.os).toLowerCase()));
        if (input.condition) { const c = String(input.condition).toLowerCase(); items = items.filter((p) => (p.condition?.label || '').toLowerCase().includes(c) || (p.condition?.parts || []).some((x) => `${x.label} ${x.value}`.toLowerCase().includes(c)) || p.variants.some((v) => (v.condition || '').toLowerCase().includes(c))); }
        if (input.in_stock_only !== false) items = items.filter((p) => p.variants.some((v) => v.available));
        if (input.sort === 'price_asc') items.sort((a, b) => low(a) - low(b));
        if (input.sort === 'price_desc') items.sort((a, b) => low(b) - low(a));
        items = items.slice(0, Math.min(Math.max(input.limit || 5, 1), 8));
        items.forEach((p) => (ctx.cache[p.handle] = p));
        return { content: JSON.stringify(items.length ? items.map(forModel) : { results: [], note: 'No matches. Try broader keywords or relax a filter.' }), events: [] };
      }
      case 'get_product': {
        const p = await cached(String(input.handle));
        return { content: JSON.stringify(p ? forModel(p) : { error: 'Product not found' }), events: [] };
      }
      case 'show_product_cards': {
        const products = (await Promise.all((input.handles || []).slice(0, 3).map(cached))).filter(Boolean);
        return { content: products.length ? 'Product cards are now displayed to the shopper. Do not repeat their details at length.' : 'No matching products to show.', events: products.length ? [{ type: 'cards', products }] : [] };
      }
      case 'cart_action': {
        if (!/^\d{6,20}$/.test(String(input.variant_id))) return { content: 'Invalid variant_id. Look it up first.', events: [], isError: true };
        const quantity = Math.min(Math.max(input.quantity || 1, 1), 10);
        return {
          content: input.action === 'buy_now' ? 'The shopper is being taken to checkout in their browser.' : "The shopper's browser is adding the item to their cart and will show a confirmation card.",
          events: [{ type: 'action', action: input.action, variantId: String(input.variant_id), quantity }],
        };
      }
      case 'lookup_order': {
        const k = orderKey(input.order_number);
        if (locked(k)) return { content: JSON.stringify({ error: 'Too many unsuccessful attempts for this order. For security, tell the shopper to contact the team directly.' }), events: [] };
        const o = await lookupOrder(input.order_number, input.email);
        if (o) fails.delete(k); else fails.set(k, [...(fails.get(k) || []), Date.now()]);
        return { content: JSON.stringify(o || NOT_FOUND), events: [] };
      }
      case 'search_knowledge': {
        if (!kbStats().chunks) return { content: JSON.stringify({ results: [], note: 'The knowledge base is empty. Say you do not have that information and offer a person (request_human).' }), events: [] };
        const r = searchKb(String(input.query || '').slice(0, 200), 4);
        return { content: JSON.stringify({ results: r.map((x) => ({ title: x.title, source_url: x.url || undefined, text: x.text.slice(0, 1200), match_score: x.score })), note: !r.length ? 'No relevant information found. Say you do not know and offer a person (request_human).' : r[0].score < 1.5 ? 'Low confidence: only use a result if it clearly answers the question.' : undefined }), events: [] };
      }
      case 'request_human': {
        const h = hoursStatus(), text = str('SUPPORT_HOURS_TEXT');
        return {
          content: h.open ? 'The contact form is now shown. The team is open and replies by email. Do not promise a reply time.' : `The contact form is now shown. The team is CLOSED right now and replies on the next working day${text ? ` (${text})` : ''}. Do not promise an immediate reply.`,
          events: [{ type: 'form', kind: input.kind === 'enquiry' ? 'enquiry' : 'human', reason: String(input.reason || '').slice(0, 300), open: h.open, hoursText: text }],
        };
      }
      default:
        return { content: 'Unknown tool', events: [], isError: true };
    }
  } catch (e) {
    console.error(`[tool:${name}]`, e.message);
    return { content: 'The store system is temporarily unavailable. Apologise briefly and offer human support.', events: [], isError: true };
  }
}
