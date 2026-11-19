// Simulated external services for the audit: Shopify public catalogue + website pages, OpenAI, Resend, a webhook, Twilio, Supabase (PostgREST).
import http from 'node:http';

export const mode = { store: 'ok', llm: 'ok', twilio: 'ok' };
export const captured = { lastReq: null, emails: [], hooks: [], sms: [], rows: [], tokenCalls: 0 };

const mk = (id, title, handle, type, price, { compare = null, avail = true, body = '<p>- Solid build quality.</p>', tags = ['woo_import_1'], variants, options } = {}) => ({
  id, title, handle, vendor: title.split(' ')[0], product_type: type, tags, body_html: body, options: options || [{ name: 'Title', position: 1, values: ['Default Title'] }],
  variants: variants || [{ id: id + 1, title: 'Default Title', option1: 'Default Title', price: price.toFixed(2), compare_at_price: compare && compare.toFixed(2), available: avail }],
  images: [{ src: `https://cdn.example/${handle}.jpg` }], image: { src: `https://cdn.example/${handle}.jpg` },
});
export const CATALOGUE = [
  mk(1, 'Lenovo Laptop Yoga Slim 7 Aura - Intel Ultra 7 Series 7 16GB DDR5 RAM 1TB SSD 14" OLED FHD Screen', 'lenovo-yoga', 'Laptop', 919, { body: '<p>- OLED screen.<br>- 16GB RAM and 1TB SSD.<br>Only one available and in fantastic condition.</p>' }),
  mk(2, 'ASUS Laptop VivoBook S14 - AMD Ryzen AI 5 16GB DDR5 RAM 1TB SSD 14" OLED FHD Screen', 'asus-s14', 'Laptop', 519, { tags: ['Refurbished', 'Grade A'], body: '<p>- Ryzen AI 5 processor.<br>- 16GB DDR5 RAM.<br>Only one available.</p>' }),
  mk(3, 'ASUS Laptop X1504MA - Brand New Intel Core 5 8GB DDR5 RAM 512GB SSD Windows 11 Home 15.6" IPS FHD Screen', 'asus-x1504', 'Laptop', 369, { compare: 539.97 }),
  mk(4, 'ASUS Laptop E410 - Intel Celeron 4GB RAM 128GB SSD Windows 11 Home 14" HD Screen', 'asus-e410', 'Laptop', 129, { avail: false, body: '<p>Only one available!</p>' }),
  mk(5, 'HP Laptop 15-fd1504sax - Intel Core 3 8GB RAM 256GB SSD Windows 11 Home 15.6" HD Screen', 'hp-15', 'Laptop', 299),
  mk(6, 'HP Laptop 14s-dq0508sa - Intel Quad-Core 4GB RAM 128GB SSD Windows 11 Home 14" HD Screen', 'hp-14s', 'Laptop', 149, { compare: 209, avail: false }),
  mk(7, 'Acer Laptop Chromebook 514 - Intel Core 3 8GB DDR5 RAM 128GB eMMC ChromeOS 14" IPS FHD Screen', 'acer-chromebook', 'Laptop', 219),
  mk(8, 'Dell Latitude 5420 - Intel Core i5 16GB RAM 256GB SSD Windows 11 Pro 14" FHD Screen', 'dell-5420', 'Laptop', 349, {
    options: [{ name: 'Condition', position: 1, values: ['Grade A', 'Grade B'] }],
    variants: [{ id: 801, title: 'Grade A', option1: 'Grade A', price: '399.00', compare_at_price: null, available: true }, { id: 802, title: 'Grade B', option1: 'Grade B', price: '349.00', compare_at_price: null, available: true }] }),
  mk(9, 'Norton 360 Deluxe 1 Year Subscription', 'norton-360', 'Software', 29.99, { body: '<p>Antivirus protection.</p>' }),
  mk(10, 'Microsoft Office 2021 Home and Student', 'office-2021', 'Software', 59, { body: '<p>Word, Excel and PowerPoint.</p>' }),
  mk(11, 'RAM Upgrade Service', 'ram-upgrade', 'Service', 25, { options: [{ name: 'Size', position: 1, values: ['8GB', '16GB', '32GB'] }], variants: [
    { id: 901, title: '8GB', option1: '8GB', price: '25.00', compare_at_price: null, available: true }, { id: 902, title: '16GB', option1: '16GB', price: '45.00', compare_at_price: null, available: true }, { id: 903, title: '32GB', option1: '32GB', price: '90.00', compare_at_price: null, available: false }] }),
  mk(12, 'Laptop Sleeve Bag 15.6"', 'laptop-bag', 'Accessory', 15),
];

const page = (title, body) => `<html><head><title>${title} | Laptop Station</title></head><body><header><nav>Home Shop Cart</nav></header><main><h1>${title}</h1>${body}</main><footer>Copyright Laptop Station</footer></body></html>`;
const PAGES = {
  '/pages/warranty': page('Warranty', '<p>All laptops come with a 12-month warranty covering hardware faults.</p><h2>How to claim</h2><p>Email support with your order number and we will arrange a collection.</p>'),
  '/pages/delivery': page('Delivery', '<p>We ship with DPD. Orders placed before 2pm are dispatched the same working day. Delivery is free over £100.</p>'),
  '/pages/about': page('About us', '<p>Laptop Station sells new and refurbished laptops.</p>'),
  '/policies/refund-policy': page('Refund policy', '<p>You can return a laptop within 30 days for a refund.</p>'),
};
const chunk = (delta, fin = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;

function script(j) {
  const tools = j.messages.filter((m) => m.role === 'tool'), n = tools.length;
  const u = ([...j.messages].reverse().find((m) => m.role === 'user')?.content || '').toLowerCase();
  if (u.includes('asus')) {
    if (n === 0) return { call: ['search_products', { query: 'asus', max_price: 600 }] };
    if (n === 1) { let h = 'x'; try { h = JSON.parse(tools[0].content)[0].handle; } catch (_) { /* ignore */ } return { call: ['show_product_cards', { handles: [h] }] }; }
    return { text: 'Here is an ASUS option.' };
  }
  if (u.includes('warranty')) return n === 0 ? { call: ['search_knowledge', { query: 'how long is the warranty' }] } : { text: 'Our warranty is 12 months.' };
  if (u.includes('speak to a person')) return n === 0 ? { call: ['request_human', { reason: 'Wants to speak to someone', kind: 'human' }] } : { text: 'I have opened a form for you.' };
  if (u.includes('norton')) return n === 0 ? { call: ['search_products', { query: 'norton', kind: 'addon' }] } : { text: 'Yes, we stock Norton.' };
  if (u.includes('order')) return n === 0 ? { call: ['lookup_order', { order_number: '1001', email: 'jo@example.com' }] } : { text: 'Order check done.' };
  return { text: 'Hi there!' };
}

export function startMock(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let body = ''; req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = (code, o) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (url.pathname === '/products.json') { if (mode.store !== 'ok') { res.statusCode = 429; return res.end('Too Many Requests'); } return json(200, { products: CATALOGUE }); }
      if (url.pathname === '/sitemap.xml') { res.setHeader('content-type', 'application/xml'); return res.end(`<sitemapindex><sitemap><loc>http://localhost:${port}/sitemap_pages_1.xml</loc></sitemap><sitemap><loc>http://localhost:${port}/sitemap_products_1.xml</loc></sitemap></sitemapindex>`); }
      if (url.pathname === '/sitemap_pages_1.xml') { res.setHeader('content-type', 'application/xml'); return res.end(['/pages/warranty', '/pages/delivery', '/pages/about'].map((p) => `<url><loc>http://localhost:${port}${p}</loc></url>`).join('')); }
      if (PAGES[url.pathname]) { res.setHeader('content-type', 'text/html'); return res.end(PAGES[url.pathname]); }
      if (url.pathname === '/v1/chat/completions') {
        if (mode.llm === '401') return json(401, { error: { message: 'Incorrect API key', type: 'invalid_request_error' } });
        const j = JSON.parse(body); captured.lastReq = j;
        res.setHeader('content-type', 'text/event-stream');
        const s = script(j);
        if (s.call) {
          const [name, args] = s.call, a = JSON.stringify(args), h = Math.floor(a.length / 2);
          res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: '' } }] }));
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: a.slice(0, h) } }] })); res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: a.slice(h) } }] }));
          res.write(chunk({}, 'tool_calls'));
        } else { res.write(chunk({ role: 'assistant', content: s.text.slice(0, 6) })); res.write(chunk({ content: s.text.slice(6) })); res.write(chunk({}, 'stop')); }
        res.write('data: [DONE]\n\n'); return res.end();
      }
      if (url.pathname === '/resend') { captured.emails.push({ auth: req.headers.authorization, body: JSON.parse(body) }); return json(200, { id: 'em_1' }); }
      if (url.pathname === '/hook') { captured.hooks.push(JSON.parse(body)); return json(200, { ok: true }); }
      if (url.pathname.startsWith('/twilio/2010-04-01/Accounts/')) {
        if (mode.twilio !== 'ok') return json(500, { message: 'boom' });
        captured.sms.push({ auth: req.headers.authorization, form: Object.fromEntries(new URLSearchParams(body)) }); return json(201, { sid: 'SM1' });
      }
      if (url.pathname === '/admin/oauth/access_token') { captured.tokenCalls++; return json(200, { access_token: `tok${captured.tokenCalls}`, scope: 'read_orders', expires_in: Number(process.env.MOCK_TOKEN_TTL || 86399) }); }
      if (url.pathname === '/rest/v1/ls_records') {
        if (req.headers.apikey !== 'sk') return json(401, { message: 'bad key' });
        const rows = captured.rows, q = url.searchParams, idq = q.get('id');
        if (req.method === 'POST') { rows.push(JSON.parse(body)); res.statusCode = 201; return res.end(); }
        if (req.method === 'GET') { const c = (q.get('collection') || '').replace(/^eq\./, ''); const off = +q.get('offset') || 0, lim = +q.get('limit') || 1000; return json(200, rows.filter((r) => r.collection === c).slice(off, off + lim)); }
        if (req.method === 'PATCH') { const id = idq.replace(/^eq\./, ''); const r = rows.find((x) => x.id === id); if (r) Object.assign(r, JSON.parse(body)); res.statusCode = 204; return res.end(); }
        if (req.method === 'DELETE') { const ids = idq.replace(/^in\.\(|\)$/g, '').split(','); for (const id of ids) { const i = rows.findIndex((x) => x.id === id); if (i >= 0) rows.splice(i, 1); } res.statusCode = 204; return res.end(); }
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
