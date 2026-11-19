/*! Laptop Station chat widget: vanilla JS, no build step. */
(() => {
  if (window.__LS_CHAT__) return;
  window.__LS_CHAT__ = true;

  const script = document.currentScript || document.querySelector('script[src*="ls-chat"]');
  const ds = (script && script.dataset) || {};
  const API = (ds.api || new URL(script.src, location.href).origin).replace(/\/$/, '');
  const CUR = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || ds.currency || 'GBP';
  const CFG = {
    title: ds.title || 'Laptop Station Assistant',
    accent: ds.accent || '#4545c4',
    handle: ds.productHandle || '',
    support: ds.supportUrl || '',
    logo: ds.logo || '',
    greeting: ds.greeting || 'Hi! How can I help you find the right laptop today?',
    placeholder: ds.placeholder || 'Ask about laptops, prices, delivery or your order…',
    privacy: 'Please do not share card details, passwords or other sensitive information in chat.',
    faqs: window.LS_CHAT_FAQS || [
      { q: 'Do you offer free delivery?' }, { q: 'What warranty do the laptops come with?' }, { q: 'Can I return a laptop?' },
      { q: 'Do you accept Klarna or ClearPay?' }, { q: 'Where is my order?' }, { q: 'Help me choose a laptop' },
    ],
  };
  const KEY = 'ls.v1';
  const SS = { get: (k) => { try { return sessionStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) { /* private mode */ } } };

  const state = { view: 'chat', busy: false, opened: false, cart: null, product: null, log: [], ui: [], token: '', tokenExp: 0, sessionId: '', config: {}, addonsShown: false, addonsBusy: false, sessionP: null, live: null };
  let saved = null;
  try { saved = JSON.parse(SS.get(KEY) || 'null'); } catch (_) { saved = null; }
  if (saved) { state.sessionId = saved.sid || ''; state.liveSaved = saved.live || null; state.log = saved.log || []; state.ui = saved.ui || []; state.addonsShown = Boolean(saved.addons); }

  // ---------- helpers ----------
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };
  const ICON = {
    chat: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
    cart: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.4a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L21 7H6"/></svg>',
    full: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6 3.3 10l12 2-12 2z"/></svg>',
  };
  const ico = (n) => { const s = h('span', { class: 'ls-ico', 'aria-hidden': 'true' }); s.innerHTML = ICON[n]; return s; };
  const money = (n, cur = CUR) => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(n); } catch (_) { return `${cur} ${Number(n).toFixed(2)}`; } };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = (t) => {
    let out = '', list = false;
    for (const raw of esc(t).split('\n')) {
      const l = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      const m = l.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
      if (m) { if (!list) { out += '<ul>'; list = true; } out += `<li>${m[1]}</li>`; }
      else { if (list) { out += '</ul>'; list = false; } if (l.trim()) out += `<p>${l}</p>`; }
    }
    return out + (list ? '</ul>' : '');
  };
  const highlights = (text = '') => text.split(/\n+|•|·|\s-\s|(?<=[.!?])\s/).map((s) => s.trim()).filter((s) => s.length >= 8 && s.length <= 110).slice(0, 3);
  // Shopify /products/<handle>.js (prices in cents) -> canonical shape (major units)
  const fromAjax = (p) => ({
    handle: p.handle, title: p.title, url: `/products/${p.handle}`, currency: CUR, image: p.featured_image || (p.images && p.images[0]) || '',
    highlights: highlights(new DOMParser().parseFromString(p.description || '', 'text/html').body.textContent),
    variants: p.variants.map((v) => ({ id: String(v.id), title: v.title, price: v.price / 100, compareAt: v.compare_at_price ? v.compare_at_price / 100 : null, available: v.available, quantity: null })),
  });

  // Condition panel: one row per part with a dot rating (6 dots, like the product page).
  const DOT_SCALE = [['nearly mint', 5], ['like new', 6], ['mint', 6], ['lightly used', 4], ['good', 3], ['used', 3], ['worn', 2], ['heavy', 1]];
  const dotsFor = (v) => { const t = String(v).toLowerCase(); for (const [k, n] of DOT_SCALE) if (t.includes(k)) return n; return null; };
  const condPanel = (parts) => {
    const rows = parts.filter((x) => !/^notes?$/i.test(x.label)), note = parts.find((x) => /^notes?$/i.test(x.label));
    return h('div', { class: 'ls-cp' },
      ...rows.map((x) => { const n = dotsFor(x.value), v = String(x.value).replace(/\s*condition$/i, '');
        return h('div', { class: 'ls-cp-row' }, h('span', { class: 'ls-cp-l' }, x.label), h('span', { class: 'ls-cp-v' }, v),
          n ? h('span', { class: 'ls-cp-d', role: 'img', 'aria-label': `${n} out of 6` }, ...Array.from({ length: 6 }, (_, i) => h('i', { class: i < n ? 'on' : '' }))) : null); }),
      note ? h('div', { class: 'ls-cp-note' }, note.value) : null);
  };

  // Product links are relative (/products/..). Off the store (test page, preview), point them at the real storefront.
  const storeLink = (u) => { try { const base = state.config.storeUrl; if (base && /^\//.test(u) && new URL(base).hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, '')) return base.replace(/\/$/, '') + u; } catch (e) { /* keep relative */ } return u; };

  // ---------- API (signed session token; refreshed automatically) ----------
  async function ensureSession(force) {
    if (!force && state.token && state.tokenExp > Date.now() + 60_000) return;
    state.sessionP ??= (async () => {
      try {
        const r = await fetch(`${API}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: state.sessionId || undefined }) });
        if (!r.ok) throw new Error('session');
        const j = await r.json();
        Object.assign(state, { token: j.token, tokenExp: Date.now() + j.expiresIn * 1000, sessionId: j.sessionId });
      } finally { state.sessionP = null; }
    })();
    return state.sessionP;
  }
  async function apiFetch(path, { method = 'POST', body } = {}) {
    await ensureSession();
    const go = () => fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` }, body: body ? JSON.stringify(body) : undefined });
    let r = await go();
    if (r.status === 401) { await ensureSession(true); r = await go(); }
    return r;
  }
  const track = (name, handle) => { apiFetch('/api/event', { body: { name, handle } }).catch(() => {}); };

  // ---------- Shopify cart (same-origin Ajax API: the shopper's real cart) ----------
  const JSONH = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const cartGet = () => fetch('/cart.js', { headers: { Accept: 'application/json' } }).then((r) => r.json());
  const cartAdd = async (id, quantity = 1) => {
    const r = await fetch('/cart/add.js', { method: 'POST', headers: JSONH, body: JSON.stringify({ items: [{ id: Number(id), quantity }] }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && (j.description || j.message)) || (r.status === 404 ? 'the cart is only available on the store’s own website, not on this page' : `the store returned an error (${r.status})`));
    return j || {};
  };
  const cartChange = (line, quantity) => fetch('/cart/change.js', { method: 'POST', headers: JSONH, body: JSON.stringify({ line, quantity }) }).then((r) => r.json());
  const syncTheme = () => { document.dispatchEvent(new CustomEvent('cart:refresh')); document.dispatchEvent(new CustomEvent('ls-chat:cart-updated', { detail: state.cart })); };
  const refreshCart = async () => { state.cart = await cartGet(); renderBadge(); if (state.view === 'cart') renderCart(); syncTheme(); };

  // ---------- DOM ----------
  const root = h('div', { class: 'ls-chat' });
  root.style.setProperty('--ls-accent', CFG.accent);
  const avatar = (cls) => { const a = h('div', { class: cls }); fillAvatar(a); return a; };
  const logoUrl = () => CFG.logo || state.config.logoUrl || '';
  function fillAvatar(a) { a.replaceChildren(logoUrl() ? h('img', { src: logoUrl(), alt: '' }) : 'AI'); }

  const launcher = h('button', { class: 'ls-launcher', type: 'button', 'aria-label': 'Open chat', onclick: () => toggle(true) }, ico('chat'));
  const badge = h('span', { class: 'ls-badge', hidden: true }, '0');
  const cartBtn = h('button', { class: 'ls-hbtn', type: 'button', title: 'Cart', 'aria-label': 'Open cart', onclick: () => setView(state.view === 'cart' ? 'chat' : 'cart') }, ico('cart'), badge);
  const fullBtn = h('button', { class: 'ls-hbtn ls-fullbtn', type: 'button', title: 'Full screen', 'aria-label': 'Toggle full screen', onclick: () => win.classList.toggle('ls-full') }, ico('full'));
  const closeBtn = h('button', { class: 'ls-hbtn', type: 'button', title: 'Minimise', 'aria-label': 'Minimise chat', onclick: () => toggle(false) }, ico('close'));
  const hText = document.createTextNode('AI assistant available');
  const header = h('header', { class: 'ls-header' }, avatar('ls-avatar'),
    h('div', { class: 'ls-hcopy' }, h('strong', {}, CFG.title), h('small', {}, h('i', { class: 'ls-dot' }), hText)), cartBtn, fullBtn, closeBtn);
  const tools = h('nav', { class: 'ls-tools' },
    h('button', { type: 'button', onclick: () => setView(state.view === 'help' ? 'chat' : 'help') }, 'Help & FAQs'),
    h('button', { type: 'button', onclick: () => download() }, 'Download chat'));
  const msgs = h('div', { class: 'ls-messages', role: 'log', 'aria-live': 'polite' });
  const helpPanel = h('div', { class: 'ls-panel', hidden: true });
  const cartPanel = h('div', { class: 'ls-panel', hidden: true });
  const input = h('textarea', { rows: 1, placeholder: CFG.placeholder, maxlength: 1000, 'aria-label': 'Message' });
  const form = h('form', { class: 'ls-form', onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); input.value = ''; autosize(); send(t); } },
    input, h('button', { class: 'ls-send', type: 'submit', 'aria-label': 'Send' }, ico('send')));
  const liveBar = h('div', { class: 'ls-live', hidden: true });
  const liveActions = h('div', { class: 'ls-actions', hidden: true });
  const privacyEl = h('p', { class: 'ls-privacy' }, CFG.privacy);
  const win = h('section', { class: 'ls-window', hidden: true, 'aria-label': CFG.title }, header, tools, liveBar, h('div', { class: 'ls-body' }, msgs, helpPanel, cartPanel), liveActions, form, privacyEl);
  root.append(launcher, win);

  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 110)}px`; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  const renderBadge = () => { const n = state.cart ? state.cart.item_count : 0; badge.textContent = n; badge.hidden = !n; };
  const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };
  const persist = () => {
    SS.set(KEY, JSON.stringify({ sid: state.sessionId, log: state.log.slice(-16), addons: state.addonsShown, open: !win.hidden, live: state.live && { id: state.live.id, after: state.live.after, seen: [...state.live.seen].slice(-20) }, handle: CFG.handle,
      ui: state.ui.slice(-40).map((u) => (u.t === 'cards' ? { t: 'cards', products: u.products.map(({ description, ...p }) => p) } : u)) }));
  };
  const pushUi = (e) => { state.ui.push(e); persist(); };

  function setView(v) {
    state.view = v; helpPanel.hidden = v !== 'help'; cartPanel.hidden = v !== 'cart';
    if (v === 'help') renderHelp();
    if (v === 'cart') { renderCart(); refreshCart().catch(() => {}); }
  }
  function toggle(open) {
    win.hidden = !open; launcher.hidden = open; if (open) launcher.classList.remove('ls-ping');
    if (open && !state.opened) { state.opened = true; greet(); }
    if (open) setTimeout(() => input.focus(), 50);
    persist();
  }

  // ---------- messages ----------
  const botGroup = () => { const col = h('div', { class: 'ls-col' }); msgs.append(h('div', { class: 'ls-m ls-bot' }, avatar('ls-mini'), col)); scroll(); return col; };
  const bubble = (col, text) => { const b = h('div', { class: 'ls-bubble' }); b.innerHTML = md(text); col.append(b); scroll(); return b; };
  const bot = (text) => { const b = bubble(botGroup(), text); pushUi({ t: 'bot', text }); return b; };
  const userMsg = (text) => { msgs.append(h('div', { class: 'ls-m ls-user' }, h('div', { class: 'ls-bubble' }, text))); scroll(); };

  async function enrichProduct() {
    if (!CFG.handle || !state.product || state.product.enriched) return;
    try {
      const r = await apiFetch(`/api/product?handle=${encodeURIComponent(CFG.handle)}`, { method: 'GET' });
      if (r.ok) { const s = await r.json(); Object.assign(state.product, { specs: s.specs, condition: s.condition, isAddon: s.isAddon, enriched: true }); }
    } catch (_) { /* optional extras only */ }
  }
  async function greet() {
    const col = botGroup();
    if (CFG.handle && !state.product) await productReady;
    await enrichProduct();
    if (state.product) {
      const t = `You’re viewing ${state.product.title}. Ask me about its features, price, delivery or alternatives.`;
      bubble(col, t); col.append(productCard(state.product)); pushUi({ t: 'bot', text: t }); pushUi({ t: 'cards', products: [state.product] });
    } else { bubble(col, CFG.greeting); pushUi({ t: 'bot', text: CFG.greeting }); }
    renderChips();
  }
  const faqs = () => (state.config.faqs && state.config.faqs.length ? state.config.faqs : CFG.faqs);
  function renderChips() {
    msgs.querySelector('.ls-chips')?.remove();
    msgs.append(h('div', { class: 'ls-chips' }, faqs().slice(0, 6).map((f) => h('button', { type: 'button', onclick: () => faq(f) }, f.q))));
    scroll();
  }
  function faq(f) {
    setView('chat');
    if (!f.a) return send(f.q);
    msgs.querySelector('.ls-chips')?.remove();
    userMsg(f.q); pushUi({ t: 'user', text: f.q });
    const a = f.a + (f.url ? `\n\n[Source](${f.url})` : '');
    bubble(botGroup(), a); pushUi({ t: 'bot', text: a });
    state.log.push({ role: 'user', content: f.q }, { role: 'assistant', content: f.a }); persist();
  }
  function renderHelp() {
    helpPanel.replaceChildren(h('h4', {}, 'Help & FAQs'), ...faqs().map((f) => h('button', { class: 'ls-faq', type: 'button', onclick: () => faq(f) }, f.q)),
      h('button', { class: 'ls-btn ls-btn-f', type: 'button', onclick: () => { setView('chat'); if (state.config.live && state.config.live.available && !state.live) startLive(); else showForm({ kind: 'human', reason: '' }); } }, 'Talk to a person'),
      (CFG.support || state.config.supportUrl) ? h('a', { class: 'ls-btn ls-btn-o', href: CFG.support || state.config.supportUrl, target: '_blank', rel: 'noopener' }, 'Message us on WhatsApp / contact page') : null);
  }
  function download() {
    const txt = state.log.map((m) => `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`).join('\n\n') || 'No messages yet.';
    const a = h('a', { href: URL.createObjectURL(new Blob([txt], { type: 'text/plain' })), download: 'laptop-station-chat.txt' });
    document.body.append(a); a.click(); a.remove();
  }

  // ---------- product card + carousel ----------
  function productCard(p) {
    let vi = Math.max(0, p.variants.findIndex((v) => v.available));
    const price = h('div', { class: 'ls-price' }), stock = h('div', { class: 'ls-stock' }), cond = h('span', { class: 'ls-cond', hidden: true }), condBox = h('div', { class: 'ls-cp-wrap', hidden: true });
    const add = h('button', { class: 'ls-btn ls-btn-o', type: 'button' }, 'Add to cart');
    const buy = h('button', { class: 'ls-btn ls-btn-f', type: 'button' }, 'Buy now');
    const select = p.variants.length > 1 ? h('select', { class: 'ls-select', 'aria-label': 'Variant', onchange: (e) => { vi = +e.target.value; upd(); } },
      p.variants.map((v, i) => h('option', { value: i, selected: i === vi, disabled: !v.available }, `${v.title} — ${money(v.price, p.currency)}${v.available ? '' : ' (sold out)'}`))) : null;
    const upd = () => {
      const v = p.variants[vi];
      price.replaceChildren(...(v.compareAt && v.compareAt > v.price ? [h('del', {}, money(v.compareAt, p.currency)), ' '] : []), h('ins', {}, money(v.price, p.currency)));
      stock.textContent = !v.available ? 'Out of stock' : v.quantity != null && v.quantity <= 5 ? `Only ${v.quantity} left` : 'In stock';
      stock.classList.toggle('ls-out', !v.available);
      const c = v.condition || (p.condition && p.condition.label) || '';
      cond.textContent = c; cond.hidden = !c;
      const parts = (p.condition && p.condition.parts) || [];
      condBox.replaceChildren(...(parts.length ? [condPanel(parts)] : [])); condBox.hidden = !parts.length;
      add.disabled = buy.disabled = !v.available;
    };
    add.addEventListener('click', () => doAdd(p, p.variants[vi], add));
    buy.addEventListener('click', () => doBuy(p, p.variants[vi], buy));
    upd();
    const chips = (p.specs && p.specs.chips) || [];
    return h('article', { class: 'ls-card' },
      h('div', { class: 'ls-card-top' }, p.image ? h('img', { src: p.image, alt: '', loading: 'lazy' }) : null,
        h('div', { class: 'ls-card-info' },
          h('strong', { class: 'ls-card-title' }, p.title), cond, price, stock,
          chips.length ? h('div', { class: 'ls-specs' }, chips.map((c) => h('span', { class: 'ls-spec' }, c))) : null,
          (p.highlights || []).length ? h('ul', {}, p.highlights.slice(0, chips.length ? 2 : 3).map((x) => h('li', {}, x))) : null,
          condBox,
          h('a', { class: 'ls-details', href: storeLink(p.url), target: '_blank', rel: 'noopener' }, 'View details ↗'))),
      select, h('div', { class: 'ls-row' }, add, buy));
  }
  function renderCards(col, products) {
    if (products.length === 1) { col.append(productCard(products[0])); return; }
    const track = h('div', { class: 'ls-track' }, products.map((p) => h('div', { class: 'ls-slide' }, productCard(p))));
    const count = h('span', { class: 'ls-count' }, `1 / ${products.length}`);
    const go = (d) => track.scrollBy && track.scrollBy({ left: d * (track.firstChild.offsetWidth + 10), behavior: 'smooth' });
    track.addEventListener('scroll', () => { const i = Math.round(track.scrollLeft / ((track.firstChild.offsetWidth || 1) + 10)); count.textContent = `${Math.min(i + 1, products.length)} / ${products.length}`; });
    col.append(h('div', { class: 'ls-car' }, track, h('div', { class: 'ls-car-nav' },
      h('button', { type: 'button', 'aria-label': 'Previous product', onclick: () => go(-1) }, '‹'), count, h('button', { type: 'button', 'aria-label': 'Next product', onclick: () => go(1) }, '›'))));
    scroll();
  }

  async function doAdd(p, v, btn, quiet) {
    const label = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      await cartAdd(v.id, v.qty || 1); await refreshCart();
      track(p.isAddon ? 'addon_add' : 'add_to_cart', p.handle);
      if (!quiet) addedCard(p, v);
      return true;
    } catch (e) { bot(`I couldn’t add that to your cart: ${e.message}`); return false; }
    finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
  }
  async function doBuy(p, v, btn) { if (await doAdd(p, v, btn, true)) { track('buy_now', p.handle); location.href = '/checkout'; } }

  function renderAdded(name) {
    msgs.append(h('div', { class: 'ls-added' },
      h('div', { class: 'ls-added-h' }, h('span', { class: 'ls-check' }, '✓'), h('div', {}, h('strong', {}, 'Added to cart'), h('small', {}, 'Choose what you would like to do next.'))),
      h('p', {}, `${name} has been added to your cart.`),
      h('div', { class: 'ls-row' },
        h('button', { class: 'ls-btn ls-btn-o', type: 'button', onclick: () => toggle(false) }, 'Continue shopping'),
        h('button', { class: 'ls-btn ls-btn-o', type: 'button', onclick: () => setView('cart') }, 'View cart')),
      h('button', { class: 'ls-btn ls-btn-f ls-wide', type: 'button', onclick: () => { track('checkout_click'); location.href = '/checkout'; } }, 'Proceed to checkout')));
    scroll();
  }
  function addedCard(p, v) {
    const name = p.title + (v.title && v.title !== 'Default Title' ? ` — ${v.title}` : '');
    renderAdded(name); pushUi({ t: 'added', title: name });
    suggestAddons(p);
  }
  // One add-on suggestion per session, right after the first laptop is added (never repeated, never for add-on pages)
  async function suggestAddons(p) {
    if (state.addonsShown || state.addonsBusy || p.isAddon || !p.handle) return;
    state.addonsBusy = true;
    try {
      const r = await apiFetch('/api/addons', { body: { handle: p.handle } });
      const j = r.ok ? await r.json() : { products: [] };
      state.addonsShown = true;
      if (!j.products.length) return;
      const t = 'Popular add-ons for your order:', col = botGroup();
      bubble(col, t); const items = j.products.map((x) => ({ ...x, isAddon: true })); renderCards(col, items);
      pushUi({ t: 'bot', text: t }); pushUi({ t: 'cards', products: items });
    } catch (_) { /* optional */ } finally { state.addonsBusy = false; persist(); }
  }

  // ---------- contact / hand-over form ----------
  function showForm(info) { const col = botGroup(); renderForm(col, info); }
  function renderForm(col, info) {
    const open = info.open !== undefined ? info.open : state.config.open !== false, hoursText = info.hoursText || state.config.hoursText || '';
    const intro = open ? 'Leave your details and a member of the team will reply by email as soon as they can.' : `We’re closed right now${hoursText ? ` (${hoursText})` : ''}. Leave your details and we’ll reply on the next working day.`;
    const f = (name, label, attrs = {}) => h('label', { class: 'ls-field' }, h('span', {}, label), h('input', { name, ...attrs }));
    const msg = h('textarea', { name: 'message', rows: 3, maxlength: 1500, 'aria-label': 'Message' }, info.reason || '');
    const consent = h('input', { type: 'checkbox', name: 'consent' });
    const privacy = state.config.privacyUrl ? h('a', { href: state.config.privacyUrl, target: '_blank', rel: 'noopener' }, 'privacy policy') : 'privacy policy';
    const status = h('p', { class: 'ls-form-status', role: 'status' });
    const submit = h('button', { class: 'ls-btn ls-btn-f ls-wide', type: 'submit' }, 'Send to the team');
    const card = h('form', { class: 'ls-contact', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      const v = (n) => card.elements[n].value.trim();
      if (!v('name')) return (status.textContent = 'Please enter your name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('email'))) return (status.textContent = 'Please enter a valid email address.');
      if (!consent.checked) return (status.textContent = 'Please tick the box so we can contact you.');
      submit.disabled = true; status.textContent = 'Sending…';
      try {
        const r = await apiFetch('/api/lead', { body: { kind: info.kind || 'human', name: v('name'), email: v('email'), phone: v('phone'), message: msg.value.trim(), consent: true, page: location.pathname } });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(j.error || 'failed'), { user: Boolean(j.error) });
        const done = j.open === false ? 'Thanks, we’ve got your details. The team is closed right now, so they’ll reply on the next working day.' : 'Thanks, we’ve got your details. A member of the team will reply by email soon.';
        card.replaceWith(h('div', { class: 'ls-bubble' }, done)); pushUi({ t: 'bot', text: done });
      } catch (err) { submit.disabled = false; status.textContent = err.user ? err.message : 'Sorry, that didn’t send. Please try again or use the contact link.'; }
    } },
      h('strong', {}, info.kind === 'enquiry' ? 'Send us your enquiry' : 'Talk to a person'), h('p', { class: 'ls-muted' }, intro),
      f('name', 'Name', { autocomplete: 'name', required: true }), f('email', 'Email', { type: 'email', autocomplete: 'email', required: true }), f('phone', 'Phone (optional)', { type: 'tel', autocomplete: 'tel' }),
      h('label', { class: 'ls-field' }, h('span', {}, 'Message'), msg),
      h('label', { class: 'ls-consent' }, consent, h('span', {}, ['I agree to Laptop Station contacting me about this enquiry. See our ', privacy, '.'])),
      status, submit);
    col.append(card); scroll(); track('form_open');
  }

  // ---------- cart panel ----------
  async function changeLine(line, qty) { state.cart = await cartChange(line, Math.max(0, qty)); renderBadge(); renderCart(); syncTheme(); }
  function renderCart() {
    const c = state.cart, parts = [];
    if (state.product) parts.push(h('h4', {}, 'Viewing now'), productCard(state.product));
    parts.push(h('h4', {}, `Your cart${c && c.item_count ? ` (${c.item_count})` : ''}`));
    if (!c || !c.items.length) parts.push(h('p', { class: 'ls-muted' }, 'Your cart is empty. Ask me for a recommendation or add the product above.'));
    else {
      c.items.forEach((it, i) => parts.push(h('div', { class: 'ls-line' }, it.image ? h('img', { src: it.image, alt: '' }) : null,
        h('div', { class: 'ls-line-i' }, h('strong', {}, it.product_title), it.variant_title ? h('small', {}, it.variant_title) : null,
          h('div', { class: 'ls-qty' },
            h('button', { type: 'button', 'aria-label': 'Decrease quantity', onclick: () => changeLine(i + 1, it.quantity - 1) }, '−'), h('span', {}, it.quantity),
            h('button', { type: 'button', 'aria-label': 'Increase quantity', onclick: () => changeLine(i + 1, it.quantity + 1) }, '+'),
            h('button', { class: 'ls-link', type: 'button', onclick: () => changeLine(i + 1, 0) }, 'Remove'))),
        h('div', { class: 'ls-line-p' }, money(it.final_line_price / 100, c.currency)))));
      parts.push(h('div', { class: 'ls-sub' }, h('span', {}, 'Subtotal'), h('strong', {}, money(c.total_price / 100, c.currency))),
        h('div', { class: 'ls-row' }, h('button', { class: 'ls-btn ls-btn-o', type: 'button', onclick: () => setView('chat') }, 'Back to chat'),
          h('button', { class: 'ls-btn ls-btn-f', type: 'button', onclick: () => { track('checkout_click'); location.href = '/checkout'; } }, 'Checkout')));
    }
    cartPanel.replaceChildren(...parts);
  }

  // ---------- chat streaming ----------
  const context = () => ({
    currency: CUR, page: { path: location.pathname, title: document.title },
    product: state.product && { handle: state.product.handle, title: state.product.title, variants: state.product.variants.map((v) => ({ variant_id: v.id, title: v.title, price: v.price, available: v.available })) },
    cart: state.cart && { count: state.cart.item_count, total: state.cart.total_price / 100, items: (state.cart.items || []).map((i) => ({ title: i.product_title, variant: i.variant_title, variant_id: i.variant_id, qty: i.quantity })) },
  });
  const userError = (m) => Object.assign(new Error(m), { user: true });

  async function send(text) {
    if (state.live && text) return liveSend(text);
    if (state.busy || !text) return;
    state.busy = true; setView('chat');
    msgs.querySelector('.ls-chips')?.remove();
    userMsg(text); pushUi({ t: 'user', text }); state.log.push({ role: 'user', content: text });
    const col = botGroup();
    const typing = h('div', { class: 'ls-bubble ls-typing' }, h('i'), h('i'), h('i'));
    col.append(typing);
    let cur = null, acc = '', all = '';
    const flush = () => { if (cur && acc.trim()) pushUi({ t: 'bot', text: acc }); cur = null; acc = ''; };
    const onEvent = async (ev) => {
      if (ev.type === 'status') typing.dataset.s = ev.text;
      else if (ev.type === 'text') { typing.remove(); if (!cur) { cur = bubble(col, ''); acc = ''; } acc += ev.text; all += ev.text; cur.innerHTML = md(acc); scroll(); }
      else if (ev.type === 'cards') { typing.remove(); flush(); renderCards(col, ev.products); pushUi({ t: 'cards', products: ev.products }); scroll(); }
      else if (ev.type === 'form') { typing.remove(); flush(); if (ev.kind !== 'enquiry' && state.config.live && state.config.live.available && !state.live) renderLiveOffer(col, ev); else renderForm(col, ev); }
      else if (ev.type === 'action') {
        flush();
        const v = { id: ev.variantId, qty: ev.quantity, title: '' };
        const p = (state.product && state.product.variants.some((x) => x.id === v.id) && state.product) || { title: 'Your item' };
        if (ev.action === 'buy_now') { if (await cartAdd(v.id, v.qty).then(() => true, () => false)) { track('buy_now', p.handle); location.href = '/checkout'; } else bot('I couldn’t start checkout for that item.'); }
        else await doAdd(p, v, null);
      } else if (ev.type === 'error') throw userError(ev.message);
    };
    try {
      const res = await apiFetch('/api/chat-stream', { body: { messages: state.log.slice(-16), context: context() } });
      if (!res.ok || !res.body) throw userError(res.status === 429 ? 'You’re sending messages quickly, please wait a moment.' : res.status === 503 ? 'We’re very busy right now. Please try again shortly.' : 'Sorry, the assistant is unavailable right now. Please try again in a moment.');
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:'));
          buf = buf.slice(i + 2);
          if (line) await onEvent(JSON.parse(line.slice(5)));
        }
      }
    } catch (e) {
      typing.remove(); flush();
      const sup = CFG.support || state.config.supportUrl;
      bubble(col, (e.user ? e.message : 'Sorry, something went wrong. Please try again.') + (sup ? ` [Contact us](${sup})` : '')).classList.add('ls-err');
    } finally {
      typing.remove(); flush();
      if (all) state.log.push({ role: 'assistant', content: all });
      state.busy = false; persist();
    }
  }


  // ---------- live chat with the team (Slack) ----------
  const sysMsg = (text) => { msgs.append(h('div', { class: 'ls-sys' }, text)); scroll(); };
  function agentMsg(text, name = 'Laptop Station team') {
    const col = h('div', { class: 'ls-col' }), b = h('div', { class: 'ls-bubble ls-agent' });
    b.innerHTML = md(text);
    col.append(h('small', { class: 'ls-agent-name' }, `${name} · Laptop Station team`), b);
    msgs.append(h('div', { class: 'ls-m ls-bot' }, h('div', { class: 'ls-mini ls-agentav' }, (name || 'T')[0].toUpperCase()), col)); scroll();
  }
  let waitEl = null;
  const showWait = (on) => {
    if (on && !waitEl) { waitEl = h('div', { class: 'ls-m ls-bot' }, avatar('ls-mini'), h('div', { class: 'ls-col' }, h('div', { class: 'ls-bubble ls-typing' }, h('i'), h('i'), h('i')))); msgs.append(waitEl); scroll(); }
    if (!on && waitEl) { waitEl.remove(); waitEl = null; }
  };
  function renderLiveBar() {
    const c = state.config.live;
    liveBar.replaceChildren();
    if (!c || !c.enabled || state.live) { liveBar.hidden = true; return; }
    const on = c.available, hrs = state.config.hoursText;
    liveBar.append(h('div', { class: `ls-live-ic${on ? '' : ' ls-off'}` }, ico('chat'), h('i')),
      h('div', { class: 'ls-live-t' }, h('strong', {}, on ? 'Live Chat' : 'Live chat is closed'), h('small', {}, on ? 'Chat with our team' : (hrs ? `Hours: ${hrs}. Email us any time.` : 'Email us and we’ll reply soon.'))),
      h('button', { type: 'button', onclick: () => { setView('chat'); on ? startLive() : showForm({ kind: 'human', reason: '' }); } }, on ? 'Chat' : 'Email us'));
    liveBar.hidden = false;
  }
  function liveSetActions(mode) {
    liveActions.replaceChildren();
    if (mode === 'wait') liveActions.append(
      h('button', { type: 'button', class: 'ls-danger', onclick: () => liveCancel(false) }, 'Cancel Handoff Request'),
      h('button', { type: 'button', onclick: () => liveCancel(true) }, 'Send an Email'));
    else if (mode === 'chat') liveActions.append(h('button', { type: 'button', class: 'ls-danger', onclick: liveEnd }, 'End live chat'));
    liveActions.hidden = !mode; input.placeholder = mode ? 'Message the team…' : CFG.placeholder;
    renderLiveBar();
  }
  function renderLiveOffer(col, ev) {
    col.append(h('div', { class: 'ls-added' }, h('strong', {}, 'Our team is online'), h('p', { class: 'ls-muted' }, 'Chat live with a person now, or leave your details for an email reply.'),
      h('div', { class: 'ls-row' }, h('button', { class: 'ls-btn ls-btn-f', type: 'button', onclick: startLive }, 'Chat live'), h('button', { class: 'ls-btn ls-btn-o', type: 'button', onclick: () => showForm(ev) }, 'Email instead'))));
    scroll();
  }
  async function startLive() {
    if (state.live) return;
    setView('chat'); msgs.querySelector('.ls-chips')?.remove();
    try {
      const r = await apiFetch('/api/handoff/start', { body: { page: location.pathname } });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) { fetch(`${API}/api/config`).then((x) => x.json()).then((c) => { state.config = c; applyConfig(); }).catch(() => {}); bot('Live chat has just closed for the day. Leave your details and we’ll reply by email.'); showForm({ kind: 'human', reason: '' }); return; }
      if (!r.ok) throw new Error('start');
      state.live = { id: j.id, status: 'waiting', after: 0, seen: new Set(), fails: 0, timer: null };
      const t = 'Please wait, we’re notifying the team…';
      sysMsg(t); pushUi({ t: 'sys', text: t }); showWait(true); liveSetActions('wait'); hText.data = 'Contacting the team…'; persist(); pollLive();
    } catch (_) {
      bot('Sorry, we couldn’t reach the team just now. Leave your details and we’ll reply by email.'); showForm({ kind: 'human', reason: '' });
    }
  }
  function endLive() {
    const L = state.live; if (L) clearTimeout(L.timer);
    state.live = null; showWait(false); hText.data = 'AI assistant available'; liveSetActions(null); persist();
  }
  async function liveSend(text) {
    const L = state.live; if (!L) return;
    userMsg(text); pushUi({ t: 'user', text });
    try {
      const r = await apiFetch(`/api/handoff/${L.id}/message`, { body: { text } });
      if (r.status === 409 || r.status === 404) { endLive(); bot('That live chat has ended. You’re back with the AI assistant. Ask me anything, or tap Talk to a person to start again.'); }
      else if (!r.ok) sysMsg('That message didn’t send. Please try again.');
    } catch (_) { sysMsg('That message didn’t send. Please try again.'); }
  }
  async function liveCancel(thenEmail) {
    const L = state.live; if (!L) return;
    apiFetch(`/api/handoff/${L.id}/cancel`, { body: {} }).catch(() => {});
    const t = 'Live chat request cancelled.'; sysMsg(t); pushUi({ t: 'sys', text: t }); endLive();
    if (thenEmail) showForm({ kind: 'human', reason: '' });
  }
  async function liveEnd() {
    const L = state.live; if (!L) return;
    apiFetch(`/api/handoff/${L.id}/end`, { body: {} }).catch(() => {});
    const t = 'You ended the live chat. You’re back with the AI assistant.'; sysMsg(t); pushUi({ t: 'sys', text: t }); endLive();
  }
  function pollLive(delay) {
    const L = state.live; if (!L) return;
    clearTimeout(L.timer);
    L.timer = setTimeout(async () => {
      if (state.live !== L) return;
      try {
        const r = await apiFetch(`/api/handoff/${L.id}/poll?after=${L.after}`, { method: 'GET' });
        if (r.status === 404) { endLive(); return; }
        if (!r.ok) throw new Error('poll');
        const j = await r.json(); L.fails = 0;
        for (const m of j.messages) {
          if (L.seen.has(m.id)) continue;
          L.seen.add(m.id); L.after = Math.max(L.after, m.ts);
          if (m.from === 'visitor') continue; // already shown when sent
          showWait(false);
          if (m.from === 'agent') { agentMsg(m.text, m.agent); pushUi({ t: 'agent', text: m.text, name: m.agent }); }
          else { sysMsg(m.text); pushUi({ t: 'sys', text: m.text }); }
          if (win.hidden && m.from === 'agent') launcher.classList.add('ls-ping'); // pulse the bubble when the chat is minimised
        }
        if (j.status !== L.status) {
          L.status = j.status;
          if (j.status === 'active') { showWait(false); liveSetActions('chat'); hText.data = `Chatting with ${j.agent || 'our team'}`; }
          else if (j.status === 'waiting') { showWait(true); liveSetActions('wait'); hText.data = 'Contacting the team…'; }
          else if (j.status === 'timeout') { endLive(); bot('Sorry, nobody is available to chat right now. Leave your details and we’ll reply by email.'); showForm({ kind: 'human', reason: '' }); return; }
          else { endLive(); return; } // ended / cancelled
        }
        persist(); pollLive();
      } catch (_) { if (++L.fails >= 6) { endLive(); bot('We lost the connection to the live chat. Leave your details and we’ll reply by email.'); showForm({ kind: 'human', reason: '' }); } else pollLive(); }
    }, delay != null ? delay : (document.hidden ? 5000 : 2000));
  }

  // ---------- styles ----------
  const CSS = `
.ls-chat,.ls-chat *{box-sizing:border-box}
.ls-chat{--a:var(--ls-accent);font-family:Poppins,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;color:#1c1d2b;line-height:1.45}
.ls-chat [hidden]{display:none!important}
.ls-chat button,.ls-chat textarea,.ls-chat select,.ls-chat input{font:inherit}
.ls-chat button{cursor:pointer}
.ls-launcher{position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;background:var(--a);color:#fff;display:grid;place-items:center;box-shadow:0 8px 24px rgba(20,20,60,.3);z-index:2147482000;transition:transform .15s}
.ls-launcher:hover{transform:scale(1.06)}
.ls-window{position:fixed;right:20px;bottom:20px;width:410px;height:min(600px,calc(100vh - 40px));background:#fff;border-radius:22px;box-shadow:0 18px 60px rgba(20,20,60,.32);display:flex;flex-direction:column;overflow:hidden;z-index:2147482001}
.ls-window.ls-full{right:0;bottom:0;width:100vw;height:100vh;border-radius:0}
@media(max-width:520px){.ls-window{right:0;bottom:0;width:100vw;height:100%;border-radius:0}.ls-fullbtn{display:none}}
.ls-header{display:flex;align-items:center;gap:10px;padding:13px 14px;min-height:76px;background:var(--a);color:#fff;flex:none}
.ls-avatar,.ls-mini{flex:none;display:grid;place-items:center;border-radius:50%;font-weight:700;overflow:hidden}
.ls-avatar{width:42px;height:42px;background:#fff;color:var(--a);font-size:14px}.ls-avatar img,.ls-mini img{width:100%;height:100%;object-fit:cover}
.ls-hcopy{flex:1;min-width:0}.ls-hcopy strong{display:block;font-size:16px;line-height:1.15}
.ls-hcopy small{display:flex;align-items:center;gap:6px;font-size:12.5px;opacity:.92;margin-top:3px}
.ls-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;display:inline-block}
.ls-hbtn{position:relative;width:36px;height:36px;border:0;border-radius:10px;background:transparent;color:#fff;display:grid;place-items:center}
.ls-hbtn:hover{background:rgba(255,255,255,.16)}
.ls-ico{display:inline-grid;place-items:center}
.ls-badge{position:absolute;top:0;right:0;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#fff;color:var(--a);font-size:11px;font-weight:700;display:grid;place-items:center}
.ls-launcher.ls-ping{animation:ls-pulse 1.3s infinite}
@keyframes ls-pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.65)}100%{box-shadow:0 0 0 20px rgba(34,197,94,0)}}
.ls-live{display:flex;align-items:center;gap:10px;margin:10px 14px 0;padding:9px 12px;border:1px solid #e3e6f0;border-radius:14px;background:#fff;flex:none}
.ls-live[hidden],.ls-actions[hidden]{display:none}
.ls-live-ic{position:relative;width:38px;height:38px;border-radius:50%;background:#eef0fb;color:var(--a);display:grid;place-items:center;flex:none}
.ls-live-ic svg{width:20px;height:20px}
.ls-live-ic i{position:absolute;right:0;bottom:0;width:11px;height:11px;border-radius:50%;background:#22c55e;border:2px solid #fff}
.ls-live-ic.ls-off i{background:#9ca3af}
.ls-live-t{flex:1;min-width:0;line-height:1.25}.ls-live-t strong{display:block;font-size:14px}.ls-live-t small{color:#6b7280;font-size:12.5px}
.ls-live>button{border:0;background:var(--a);color:#fff;border-radius:10px;padding:9px 16px;font-weight:700;font-size:13.5px}
.ls-actions{display:flex;gap:8px;padding:8px 14px;background:#fff;border-top:1px solid #eceef5;flex:none}
.ls-actions button{flex:1;border-radius:10px;padding:9px 8px;font-weight:700;font-size:13px;border:1.5px solid var(--a);background:#fff;color:var(--a)}
.ls-actions .ls-danger{border-color:#e0556b;color:#c8344d;background:#fff5f6}
.ls-sys{align-self:center;background:#e9ebf3;color:#4b5263;font-size:12.5px;border-radius:999px;padding:5px 12px;text-align:center;max-width:92%}
.ls-agent-name{font-size:11.5px;color:#6b7280;margin-left:4px}
.ls-bubble.ls-agent{background:#ecfdf3;border-color:#bfe9cf}
.ls-mini.ls-agentav{background:#16a34a;display:grid;place-items:center;font-weight:700;border-radius:50%}
.ls-tools{display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid #eceef5;flex:none;background:#fff}
.ls-tools button{border:1px solid #dfe2ee;background:#fff;border-radius:10px;padding:6px 12px;font-size:13.5px}.ls-tools button:hover{border-color:var(--a)}
.ls-body{position:relative;flex:1;min-height:0;background:#f5f6fa}
.ls-messages{height:100%;overflow-y:auto;padding:16px 14px 8px;display:flex;flex-direction:column;gap:12px}
.ls-m{display:flex;gap:8px;align-items:flex-start}.ls-user{justify-content:flex-end}
.ls-mini{width:30px;height:30px;background:var(--a);color:#fff;font-size:11px}
.ls-col{display:flex;flex-direction:column;gap:8px;min-width:0;flex:1}
.ls-bubble{background:#fff;border:1px solid #e7e9f2;border-radius:16px;padding:10px 14px;max-width:100%;overflow-wrap:anywhere}
.ls-bubble p{margin:0}.ls-bubble p+p,.ls-bubble ul{margin-top:6px}.ls-bubble ul{padding-left:18px;margin-bottom:0}.ls-bubble a{color:var(--a)}
.ls-user .ls-bubble{background:var(--a);color:#fff;border-color:var(--a);max-width:85%;white-space:pre-wrap}
.ls-err{border-color:#f3b4b4;background:#fff5f5}
.ls-typing{display:inline-flex;gap:4px;align-items:center;width:max-content}
.ls-typing i{width:6px;height:6px;border-radius:50%;background:#aab;animation:ls-b 1s infinite}.ls-typing i:nth-child(2){animation-delay:.15s}.ls-typing i:nth-child(3){animation-delay:.3s}
.ls-typing[data-s]::after{content:attr(data-s);margin-left:6px;color:#6a6f86;font-size:12.5px}
@keyframes ls-b{0%,80%,100%{opacity:.3}40%{opacity:1}}
@media(prefers-reduced-motion:reduce){.ls-typing i{animation:none}.ls-launcher{transition:none}.ls-track{scroll-behavior:auto}}
.ls-chips{display:flex;flex-direction:column;align-items:flex-end;gap:8px;margin-top:4px}
.ls-chips button{border:1.5px solid var(--a);color:var(--a);background:#fff;border-radius:18px;padding:8px 14px;max-width:92%;text-align:left}.ls-chips button:hover{background:var(--a);color:#fff}
.ls-car{min-width:0}.ls-track{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:6px;scrollbar-width:thin}
.ls-slide{flex:0 0 88%;scroll-snap-align:start;min-width:0;display:flex}.ls-slide .ls-card{flex:1}
.ls-car-nav{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:2px}
.ls-car-nav button{width:30px;height:30px;border-radius:50%;border:1px solid #dfe2ee;background:#fff;font-size:18px;line-height:1;color:var(--a)}.ls-count{font-size:12px;color:#6a6f86}
.ls-card{background:#fff;border:1px solid #e3e6f0;border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:10px}
.ls-card-top{display:flex;gap:12px}.ls-card-top img{width:72px;height:72px;object-fit:contain;border-radius:12px;background:#f2f3f8;flex:none}
.ls-card-info{min-width:0;display:flex;flex-direction:column;gap:3px;align-items:flex-start}
.ls-card-title{font-size:14.5px;line-height:1.25}
.ls-cp{width:100%;box-sizing:border-box;margin-top:8px;border:1px solid #e7e4ef;border-radius:10px;background:#faf9fd;padding:4px 10px}
.ls-cp-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:5px 0;font-size:12px}
.ls-cp-row+.ls-cp-row{border-top:1px solid #efecf6}
.ls-cp-l{font-weight:600;color:#1c1d2b}
.ls-cp-v{background:#fff;border:1px solid #e0dcec;border-radius:999px;padding:0 8px;font-size:11px;color:#4a2a7a;white-space:nowrap}
.ls-cp-d{display:inline-flex;gap:3px;align-items:center}
.ls-cp-d i{width:8px;height:8px;border-radius:50%;border:1.5px solid var(--a,#4646bf);box-sizing:border-box}
.ls-cp-d i.on{background:var(--a,#4646bf)}
.ls-cp-note{font-size:11.5px;color:#5b6472;padding:5px 0 2px;border-top:1px solid #efecf6}
.ls-cond{background:#e6f4ec;color:#1b7a43;border-radius:8px;padding:1px 8px;font-size:11.5px;font-weight:600}
.ls-price{font-weight:700}.ls-price del{color:#6a6f86;font-weight:600}.ls-price ins{text-decoration:none;color:var(--a)}
.ls-stock{font-size:12.5px;font-weight:600;color:#1b7a43}.ls-stock.ls-out{color:#b3261e}
.ls-specs{display:flex;flex-wrap:wrap;gap:4px}.ls-spec{background:#f0f1f8;border-radius:8px;padding:2px 8px;font-size:11.5px;color:#3b3f57}
.ls-card ul{margin:4px 0 0;padding:0;list-style:none;font-size:12.5px;color:#4d5268}
.ls-card li{padding-left:12px;position:relative}.ls-card li::before{content:"";position:absolute;left:0;top:.6em;width:4px;height:4px;border-radius:50%;background:#e0652d}
.ls-details{font-size:12.5px;font-weight:600;color:#2f6b50;text-decoration:none;margin-top:2px}
.ls-select{width:100%;border:1px solid #dfe2ee;border-radius:10px;padding:8px 10px;background:#fff}
.ls-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ls-btn{border:1.5px solid var(--a);border-radius:11px;padding:10px 8px;font-weight:700;font-size:13.5px;text-align:center;text-decoration:none;display:block}
.ls-btn-o{background:#fff;color:var(--a)}.ls-btn-f{background:var(--a);color:#fff}
.ls-btn:disabled{opacity:.45;cursor:not-allowed}.ls-btn:not(:disabled):hover{filter:brightness(.94)}.ls-wide{width:100%}
.ls-added,.ls-contact{background:#fff;border:1px solid #e3e6f0;border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:10px}
.ls-added p{margin:0}.ls-added-h{display:flex;gap:10px;align-items:center;padding-bottom:10px;border-bottom:1px solid #eef0f6}
.ls-added-h small{display:block;color:#6a6f86;font-size:12.5px}
.ls-check{width:34px;height:34px;border-radius:50%;background:#e6f4ec;color:#1b7a43;display:grid;place-items:center;font-weight:700}
.ls-contact p{margin:0}.ls-field{display:flex;flex-direction:column;gap:3px;font-size:12.5px;color:#4d5268}
.ls-field input,.ls-field textarea{border:1px solid #cfd3e3;border-radius:10px;padding:8px 10px;color:#1c1d2b;font-size:14px;resize:vertical}
.ls-consent{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#4d5268}.ls-consent input{margin-top:3px}.ls-consent a{color:var(--a)}
.ls-form-status{font-size:12.5px;color:#b3261e;min-height:1em}
.ls-panel{position:absolute;inset:0;background:#f5f6fa;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;z-index:3}
.ls-panel h4{margin:6px 0 0;font-size:13px;color:#4d5268}.ls-muted{color:#6a6f86;margin:0}
.ls-faq{text-align:left;background:#fff;border:1px solid #e3e6f0;border-radius:12px;padding:10px 12px}.ls-faq:hover{border-color:var(--a)}
.ls-line{display:flex;gap:10px;background:#fff;border:1px solid #e3e6f0;border-radius:14px;padding:10px;align-items:flex-start}
.ls-line img{width:52px;height:52px;object-fit:contain;border-radius:8px;background:#f2f3f8}
.ls-line-i{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.ls-line-i small{color:#6a6f86}.ls-line-p{font-weight:700;white-space:nowrap}
.ls-qty{display:flex;align-items:center;gap:8px;margin-top:4px}.ls-qty button{width:26px;height:26px;border:1px solid #dfe2ee;background:#fff;border-radius:8px}
.ls-qty .ls-link{width:auto;border:0;background:none;color:#b3261e;font-size:12.5px;padding:0 4px;text-decoration:underline}
.ls-sub{display:flex;justify-content:space-between;padding:6px 2px;font-size:15px}
.ls-form{display:flex;gap:8px;align-items:flex-end;padding:10px 14px 4px;background:#fff;border-top:1px solid #eceef5;flex:none}
.ls-form textarea{flex:1;resize:none;border:0;outline:0;padding:9px 4px;max-height:110px;background:transparent;color:inherit}
.ls-send{width:42px;height:42px;border:0;border-radius:50%;background:var(--a);color:#fff;display:grid;place-items:center;flex:none}
.ls-chat :focus-visible{outline:2px solid var(--a);outline-offset:2px}
.ls-privacy{margin:0;padding:2px 16px 10px;font-size:10.5px;color:#7a7f96;text-align:center;background:#fff;flex:none}.ls-privacy a{color:inherit}
.ls-full .ls-messages,.ls-full .ls-panel{padding-left:max(14px,calc((100% - 760px)/2));padding-right:max(14px,calc((100% - 760px)/2))}
.ls-full .ls-form{padding-left:max(14px,calc((100vw - 760px)/2));padding-right:max(14px,calc((100vw - 760px)/2))}.ls-full .ls-slide{flex-basis:380px}`;

  // ---------- boot ----------
  const productReady = CFG.handle
    ? fetch(`/products/${encodeURIComponent(CFG.handle)}.js`).then((r) => (r.ok ? r.json() : null)).then((p) => { if (p) state.product = fromAjax(p); }).catch(() => {})
    : Promise.resolve();

  function applyConfig() {
    const c = state.config, bits = [CFG.privacy];
    if (c.retentionDays) bits.push(` Chats are kept for up to ${c.retentionDays} days to improve our service.`);
    privacyEl.replaceChildren(bits.join(''), c.privacyUrl ? h('span', {}, [' ', h('a', { href: c.privacyUrl, target: '_blank', rel: 'noopener' }, 'Privacy policy')]) : '');
    root.querySelectorAll('.ls-avatar,.ls-mini').forEach(fillAvatar);
    if (state.opened && !msgs.querySelector('.ls-user') && msgs.querySelector('.ls-chips')) renderChips();
    renderLiveBar();
  }
  function restore() {
    let col = null;
    for (const u of state.ui) {
      if (u.t === 'user') { userMsg(u.text); col = null; }
      else if (u.t === 'bot') { col ??= botGroup(); bubble(col, u.text); }
      else if (u.t === 'cards') { col ??= botGroup(); renderCards(col, u.products); }
      else if (u.t === 'added') { renderAdded(u.title); col = null; }
      else if (u.t === 'sys') { sysMsg(u.text); col = null; }
      else if (u.t === 'agent') { agentMsg(u.text, u.name); col = null; }
    }
    if (!state.ui.some((u) => u.t === 'user')) renderChips();
  }
  const boot = async () => {
    document.head.append(h('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap' }), h('style', {}, CSS));
    document.body.append(root);
    if (saved && state.ui.length) {
      state.opened = true; restore();
      if (CFG.handle && saved.handle !== CFG.handle) { // shopper moved to a different product page
        await productReady; await enrichProduct();
        if (state.product) { const col = botGroup(), t = `You’re now viewing ${state.product.title}.`; bubble(col, t); col.append(productCard(state.product)); pushUi({ t: 'bot', text: t }); pushUi({ t: 'cards', products: [state.product] }); }
      }
      if (saved.open) toggle(true);
    } else if (saved && saved.open) toggle(true);
    cartGet().then((c) => { state.cart = c; renderBadge(); }).catch(() => {});
    const loadConfig = () => fetch(`${API}/api/config`).then((r) => (r.ok ? r.json() : null)).then((c) => { if (c) { state.config = c; applyConfig(); } }).catch(() => {});
    await loadConfig(); setInterval(loadConfig, 300_000); // keeps the Live Chat card right as opening hours start and end
    if (state.liveSaved && state.liveSaved.id) { // resume a live chat after a page change or refresh
      state.live = { id: state.liveSaved.id, status: 'resume', after: state.liveSaved.after || 0, seen: new Set(state.liveSaved.seen || []), fails: 0, timer: null };
      liveSetActions('wait'); pollLive(0);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.LSChat = { open: () => toggle(true), close: () => toggle(false), send };
})();
