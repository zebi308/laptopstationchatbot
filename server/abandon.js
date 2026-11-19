// Abandoned-cart re-engagement (WhatsApp / SMS via Twilio). OFF by default: set ABANDON_ENABLED=1.
// Flow: Shopify checkout webhooks -> store -> scheduler waits ABANDON_DELAY_MIN -> checks (consent, opt-out, cooldown, quiet hours,
// order placed?) -> one message with the recovery link. STOP replies are handled via the Twilio inbound webhook.
import crypto from 'node:crypto';
import { str, num, flag } from './config.js';
import { localParts } from './hours.js';

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const verifyShopifyHmac = (raw, header, secret) => Boolean(secret && header) && safeEq(crypto.createHmac('sha256', secret).update(raw).digest('base64'), header);
export function twilioSignatureOk(url, params, header, token) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return Boolean(token && header) && safeEq(crypto.createHmac('sha1', token).update(data).digest('base64'), header);
}

export function normalizePhone(p, cc = str('DEFAULT_COUNTRY_CODE', '44')) {
  if (!p) return null;
  let s = String(p).replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) s = `+${s.slice(1).replace(/\D/g, '')}`; else if (s.startsWith('0')) s = `+${cc}${s.slice(1)}`; else s = `+${s}`;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}
const mask = (p) => (p ? `${p.slice(0, 5)}***${p.slice(-2)}` : '');

// Shopify checkout webhook payload -> our record. Field names follow Shopify's checkout payload; confirm with LOG_WEBHOOKS=1.
export function checkoutRecord(p) {
  const c = p.customer || {};
  return {
    key: String(p.token || p.id), checkoutId: p.id, email: String(p.email || c.email || '').toLowerCase() || null,
    phone: normalizePhone(p.phone || p.shipping_address?.phone || p.billing_address?.phone || c.phone || c.default_address?.phone),
    firstName: c.first_name || p.billing_address?.first_name || p.shipping_address?.first_name || '',
    url: p.abandoned_checkout_url || null, items: (p.line_items || []).map((i) => ({ title: i.title || i.name, qty: i.quantity })),
    total: p.total_price, currency: p.currency,
    smsConsent: (c.sms_marketing_consent || p.sms_marketing_consent)?.state === 'subscribed',
    mktConsent: p.buyer_accepts_marketing === true || c.accepts_marketing === true,
    completedAt: p.completed_at ? Date.parse(p.completed_at) : null,
  };
}

export async function onCheckout(store, payload) {
  const r = checkoutRecord(payload);
  const cur = (await store.all('checkouts')).find((c) => c.key === r.key);
  const status = r.completedAt ? 'completed' : (cur && cur.status !== 'pending' ? cur.status : 'pending');
  if (cur) { await store.update('checkouts', cur.id, { ...r, status, updatedAt: Date.now() }); return cur.id; }
  return (await store.add('checkouts', { ...r, status, updatedAt: Date.now(), tries: 0 })).id;
}

export async function onOrder(store, payload) {
  const token = payload.checkout_token && String(payload.checkout_token), cid = payload.checkout_id, email = String(payload.email || '').toLowerCase();
  let n = 0;
  for (const c of await store.all('checkouts')) {
    if (c.status !== 'pending') continue;
    if ((token && c.key === token) || (cid && String(c.checkoutId) === String(cid)) || (email && c.email === email)) { await store.update('checkouts', c.id, { status: 'completed', reason: 'order-placed' }); n++; }
  }
  return n;
}

function quietHours(now) {
  const m = str('ABANDON_WINDOW', '08:00-21:00').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const { minutes } = localParts(new Date(now), str('SUPPORT_TZ', 'Europe/London'));
  return !(minutes >= +m[1] * 60 + +m[2] && minutes < +m[3] * 60 + +m[4]);
}

function skipReason(c, optouts, all, now) {
  if (!c.url) return 'no-recovery-url';
  if (!c.items?.length) return 'empty-cart';
  if (!c.phone) return 'no-phone';
  const ok = str('ABANDON_CONSENT_MODE', 'sms') === 'marketing' ? c.smsConsent || c.mktConsent : c.smsConsent;
  if (!ok) return 'no-consent';
  if (optouts.has(c.phone)) return 'opted-out';
  if (now - c.updatedAt > num('ABANDON_MAX_AGE_HOURS', 24) * 3_600_000) return 'expired';
  const cool = num('ABANDON_COOLDOWN_DAYS', 7) * 86_400_000;
  if (all.some((o) => o.id !== c.id && o.phone === c.phone && o.status === 'sent' && now - (o.sentAt || 0) < cool)) return 'cooldown';
  if (quietHours(now)) return 'quiet-hours';
  return null;
}

export function render(c) {
  const t = (c.items || []).map((i) => String(i.title).slice(0, 60)); const rest = t.length - 2;
  const items = t.length <= 2 ? t.join(' and ') : `${t.slice(0, 2).join(', ')} and ${rest} more`;
  return str('ABANDON_TEMPLATE', 'Hi {name}, you left {items} in your basket at Laptop Station. Pick up where you left off: {url}  Reply STOP to opt out.')
    .replace('{name}', c.firstName || 'there').replace('{items}', items).replace('{url}', c.url);
}

export async function sendMessage(c) {
  const provider = str('MESSAGING_PROVIDER', process.env.TWILIO_ACCOUNT_SID ? 'twilio_sms' : 'log');
  if (provider === 'log') { console.log(`[abandon] (log only) would message ${mask(c.phone)}: ${render(c)}`); return; }
  const wa = provider === 'twilio_whatsapp', sid = str('TWILIO_ACCOUNT_SID'), tok = str('TWILIO_AUTH_TOKEN');
  const form = new URLSearchParams({ To: (wa ? 'whatsapp:' : '') + c.phone });
  if (!wa && str('TWILIO_MESSAGING_SERVICE_SID')) form.set('MessagingServiceSid', str('TWILIO_MESSAGING_SERVICE_SID'));
  else form.set('From', (wa ? 'whatsapp:' : '') + str(wa ? 'TWILIO_WHATSAPP_FROM' : 'TWILIO_FROM'));
  if (wa && str('TWILIO_CONTENT_SID')) { form.set('ContentSid', str('TWILIO_CONTENT_SID')); form.set('ContentVariables', JSON.stringify({ 1: c.firstName || 'there', 2: c.url })); } else form.set('Body', render(c));
  const r = await fetch(`${str('TWILIO_API_BASE', 'https://api.twilio.com')}/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Twilio ${r.status}`);
}

export async function sweep(store, now = Date.now(), send = sendMessage) {
  const delay = num('ABANDON_DELAY_MIN', 60) * 60_000, out = { sent: 0, skipped: 0, deferred: 0, failed: 0 };
  const optouts = new Set((await store.all('optouts')).map((o) => o.phone));
  const all = await store.all('checkouts');
  for (const c of all) {
    if (c.status !== 'pending' || now - c.updatedAt < delay) continue;
    const reason = skipReason(c, optouts, all, now);
    if (reason === 'quiet-hours') { out.deferred++; continue; }
    if (reason) { await store.update('checkouts', c.id, { status: 'skipped', reason }); out.skipped++; continue; }
    try { await send(c); await store.update('checkouts', c.id, { status: 'sent', sentAt: now }); out.sent++; }
    catch (e) { const tries = (c.tries || 0) + 1; await store.update('checkouts', c.id, tries >= 3 ? { status: 'skipped', reason: 'send-failed', tries } : { tries }); out.failed++; console.error('[abandon] send failed', e.message); }
  }
  return out;
}

const STOP = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i, START = /^(start|unstop|yes)$/i;
export async function onInbound(store, from, body) {
  const phone = normalizePhone(String(from).replace(/^whatsapp:/, '')), msg = String(body || '').trim();
  if (!phone) return '<Response/>';
  const cur = (await store.all('optouts')).filter((o) => o.phone === phone);
  if (STOP.test(msg)) { if (!cur.length) await store.add('optouts', { phone }); return '<Response><Message>You have been unsubscribed and will not receive further messages from Laptop Station.</Message></Response>'; }
  if (START.test(msg)) { await store.removeWhere('optouts', (o) => o.phone === phone); return '<Response><Message>You are subscribed again.</Message></Response>'; }
  return '<Response/>';
}

export function mountAbandon(app, store) {
  const secret = () => str('SHOPIFY_WEBHOOK_SECRET', str('SHOPIFY_CLIENT_SECRET'));
  const shopify = (handler) => async (req, res) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || !verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256'], secret())) return res.status(401).end();
    res.status(200).end();
    try {
      const p = JSON.parse(raw.toString('utf8'));
      if (flag('LOG_WEBHOOKS')) console.log(`[webhook] ${req.headers['x-shopify-topic']} keys=${Object.keys(p).join(',')} consent=${JSON.stringify({ buyer_accepts_marketing: p.buyer_accepts_marketing, sms: (p.customer?.sms_marketing_consent || p.sms_marketing_consent)?.state })}`);
      await handler(p);
    } catch (e) { console.error('[webhook]', e.message); }
  };
  app.post('/webhooks/shopify/checkouts', shopify((p) => onCheckout(store, p)));
  app.post('/webhooks/shopify/orders', shopify((p) => onOrder(store, p)));
  app.post('/webhooks/twilio/inbound', async (req, res) => {
    const token = str('TWILIO_AUTH_TOKEN');
    if (!token) return res.status(503).end();
    const params = Object.fromEntries(new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''));
    if (!twilioSignatureOk(`${str('PUBLIC_BASE_URL').replace(/\/$/, '')}/webhooks/twilio/inbound`, params, req.headers['x-twilio-signature'], token)) return res.status(403).end();
    res.type('text/xml').send(await onInbound(store, params.From, params.Body));
  });
  if (flag('ABANDON_ENABLED')) {
    setInterval(() => sweep(store).catch((e) => console.error('[abandon]', e.message)), 60_000).unref();
    console.log(`Abandoned-cart messaging ENABLED (provider ${str('MESSAGING_PROVIDER', process.env.TWILIO_ACCOUNT_SID ? 'twilio_sms' : 'log')}, delay ${num('ABANDON_DELAY_MIN', 60)} min)`);
  }
}
