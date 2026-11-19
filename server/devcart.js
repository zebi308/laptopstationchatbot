// LOCAL TESTING ONLY. Simulates Shopify's storefront endpoints (/cart.js, /cart/add.js, /cart/change.js, /products/<handle>.js)
// plus simple product and checkout pages, so the widget can be tried on http://localhost:3000 without a real store.
// Enable with DEV_MOCK_CART=1 (ignored when NODE_ENV=production). It is a SIMULATION: it never touches your real Shopify cart.
import crypto from 'node:crypto';
import { listProducts } from './public-catalog.js';

const carts = new Map(); // cookie id -> [{ id, qty }]
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cur = () => process.env.STORE_CURRENCY || 'GBP';
const money = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur() }).format(n);

function linesFor(req, res) {
  let id = (/(?:^|;\s*)ls_devcart=([\w-]+)/.exec(req.headers.cookie || '') || [])[1];
  if (!id) { id = crypto.randomUUID(); res.setHeader('Set-Cookie', `ls_devcart=${id}; Path=/; SameSite=Lax`); }
  if (!carts.has(id)) carts.set(id, []);
  return carts.get(id);
}
async function variants() { const idx = new Map(); for (const p of await listProducts()) for (const v of p.variants) idx.set(String(v.id), { p, v }); return idx; }
async function cartJson(lines) {
  const idx = await variants(), items = [];
  for (const l of lines) {
    const hit = idx.get(String(l.id)); if (!hit) continue;
    const cents = Math.round(hit.v.price * 100);
    items.push({ product_title: hit.p.title, variant_title: hit.v.title === 'Default Title' ? null : hit.v.title, variant_id: Number(l.id), quantity: l.qty, final_line_price: cents * l.qty, image: hit.p.image });
  }
  return { item_count: items.reduce((a, i) => a + i.quantity, 0), total_price: items.reduce((a, i) => a + i.final_line_price, 0), currency: cur(), items };
}
const BANNER = '<p style="background:#fff3cd;border:1px solid #e0c870;padding:8px 12px;border-radius:8px;font:14px system-ui">LOCAL TEST PAGE: a simulated store for trying the chat widget. Nothing here touches your real Shopify store.</p>';
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font:16px/1.5 system-ui;max-width:820px;margin:24px auto;padding:0 16px">${BANNER}${body}</body>`;

export function mountDevCart(app) {
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ status: 500, message: 'Dev cart error', description: e.message }));
  app.get('/cart.js', wrap(async (req, res) => res.json(await cartJson(linesFor(req, res)))));
  app.post('/cart/add.js', wrap(async (req, res) => {
    const it = (req.body && req.body.items && req.body.items[0]) || {}, id = String(it.id), qty = Math.min(Math.max(parseInt(it.quantity, 10) || 1, 1), 99);
    const hit = (await variants()).get(id);
    if (!hit) return res.status(404).json({ status: 404, message: 'Not Found', description: 'Cannot find variant' });
    if (!hit.v.available) return res.status(422).json({ status: 422, message: 'Cart Error', description: `All ${hit.p.title} are sold out.` });
    const ls = linesFor(req, res), cur_ = ls.find((l) => l.id === id);
    if (cur_) cur_.qty += qty; else ls.push({ id, qty });
    res.json({ id: Number(id), quantity: qty, title: hit.p.title });
  }));
  app.post('/cart/change.js', wrap(async (req, res) => {
    const ls = linesFor(req, res), n = parseInt(req.body && req.body.line, 10), q = parseInt(req.body && req.body.quantity, 10);
    if (n >= 1 && n <= ls.length) { if (!(q > 0)) ls.splice(n - 1, 1); else ls[n - 1].qty = Math.min(q, 99); }
    res.json(await cartJson(ls));
  }));
  app.post('/cart/clear.js', wrap(async (req, res) => { linesFor(req, res).length = 0; res.json(await cartJson([])); }));
  app.get('/checkout', wrap(async (req, res) => {
    const c = await cartJson(linesFor(req, res));
    res.type('html').send(page('Simulated checkout', `<h1>Simulated checkout</h1><p>On your real store this is Shopify's secure checkout page. Here it only proves the widget handed over the right items.</p>${c.items.length ? `<ul>${c.items.map((i) => `<li>${i.quantity} × ${esc(i.product_title)}${i.variant_title ? ` (${esc(i.variant_title)})` : ''}: ${money(i.final_line_price / 100)}</li>`).join('')}</ul><p><b>Total: ${money(c.total_price / 100)}</b></p>` : '<p>Your cart is empty.</p>'}<p><a href="/dev">Back to the simulated shop</a></p>`));
  }));
  app.get('/products/:file', wrap(async (req, res) => {
    const isJs = req.params.file.endsWith('.js'), handle = isJs ? req.params.file.slice(0, -3) : req.params.file;
    const p = (await listProducts()).find((x) => x.handle === handle);
    if (!p) return res.status(404).json(isJs ? { status: 404, message: 'Not Found', description: 'Not Found' } : { error: 'Not found' });
    if (isJs) return res.json({ id: 0, handle: p.handle, title: p.title, vendor: p.vendor, type: p.type, tags: p.tags, description: `<p>${esc(p.description).replace(/\n/g, '<br>')}</p>`, featured_image: p.image, images: [p.image],
      variants: p.variants.map((v) => ({ id: Number(v.id), title: v.title, price: Math.round(v.price * 100), compare_at_price: v.compareAt ? Math.round(v.compareAt * 100) : null, available: v.available })) });
    res.type('html').send(page(`${p.title} (simulated page)`, `<p><a href="/dev">All products</a></p><h1>${esc(p.title)}</h1>${p.image ? `<img src="${esc(p.image)}" alt="" style="max-width:260px;border-radius:12px">` : ''}<p><b>${money(Math.min(...p.variants.map((v) => v.price)))}</b></p><p>${esc(p.description).replace(/\n/g, '<br>')}</p>` +
      `<script src="/widget/ls-chat.js" data-product-handle="${esc(p.handle)}" data-currency="${esc(cur())}" defer></script>`));
  }));
  app.get('/dev', wrap(async (_req, res) => {
    const ps = (await listProducts()).slice(0, 40);
    res.type('html').send(page('Simulated shop', `<h1>Simulated shop (local testing)</h1><p>Open a product page to see the chat greet the shopper with that product, then try Add to cart and the checkout hand-over.</p><ul>${ps.map((p) => `<li><a href="/products/${esc(p.handle)}">${esc(p.title)}</a> (${money(Math.min(...p.variants.map((v) => v.price)))})</li>`).join('')}</ul><script src="/widget/ls-chat.js" defer></script>`));
  }));
}
