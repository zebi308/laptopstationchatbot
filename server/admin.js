// Admin API + dashboard (set ADMIN_TOKEN). Leads, conversations, analytics, KB refresh, GDPR delete.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteSubject } from './store.js';
import { kbStats } from './kb/search.js';
import { budgetUsed, rateLimited, recentErrors } from './security.js';

const html = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin.html');
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; }; // also defuses spreadsheet formulas

export async function conversations(store) {
  const by = new Map();
  for (const m of await store.all('messages')) {
    const c = by.get(m.sessionId) || { sessionId: m.sessionId, first: m.ts, last: m.ts, messages: 0, page: m.page || '', preview: '', tools: 0 };
    c.last = Math.max(c.last, m.ts); c.first = Math.min(c.first, m.ts); c.messages++; c.tools += (m.tools || []).length;
    if (!c.preview && m.role === 'user') c.preview = m.content.slice(0, 120);
    by.set(m.sessionId, c);
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

export async function stats(store, now = Date.now()) {
  const convs = await conversations(store), leads = await store.all('leads'), events = await store.all('events'), checkouts = await store.all('checkouts');
  const day = 86_400_000, since = (d) => now - d * day;
  const series = Array.from({ length: 14 }, (_, i) => { const t = new Date(now - (13 - i) * day).toISOString().slice(0, 10); return { date: t, conversations: convs.filter((c) => new Date(c.first).toISOString().slice(0, 10) === t).length }; });
  const count = (name) => events.filter((e) => e.name === name).length;
  return {
    conversations: { total: convs.length, last7d: convs.filter((c) => c.first >= since(7)).length, last30d: convs.filter((c) => c.first >= since(30)).length },
    messages: convs.reduce((a, c) => a + c.messages, 0), toolCalls: convs.reduce((a, c) => a + c.tools, 0),
    leads: { total: leads.length, human: leads.filter((l) => l.kind === 'human').length, enquiry: leads.filter((l) => l.kind === 'enquiry').length, outOfHours: leads.filter((l) => l.open === false).length },
    events: { addToCart: count('add_to_cart'), buyNow: count('buy_now'), checkoutClick: count('checkout_click'), addonAdded: count('addon_add') },
    abandonedCart: { sent: checkouts.filter((c) => c.status === 'sent').length, skipped: checkouts.filter((c) => c.status === 'skipped').length, pending: checkouts.filter((c) => c.status === 'pending').length, completed: checkouts.filter((c) => c.status === 'completed').length },
    kb: kbStats(), aiBudget: budgetUsed(), series, errors: recentErrors(),
  };
}

export function mountAdmin(app, store, { refreshKb }) {
  const token = () => process.env.ADMIN_TOKEN;
  app.get('/admin', (_req, res) => (token() ? res.sendFile(html) : res.status(404).send('Admin disabled: set ADMIN_TOKEN')));
  app.use('/admin/api', (req, res, next) => {
    const t = token(), h = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (t && h.length === t.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(t))) return next();
    if (rateLimited(`admin:${req.ip}`, 20, 3_600_000)) return res.status(429).json({ error: 'Too many attempts' });
    res.status(t ? 401 : 404).json({ error: t ? 'Unauthorised' : 'Admin disabled' });
  });
  app.get('/admin/api/stats', async (_req, res) => res.json(await stats(store)));
  app.get('/admin/api/leads', async (_req, res) => res.json((await store.all('leads')).sort((a, b) => b.ts - a.ts).slice(0, 500)));
  app.get('/admin/api/conversations', async (_req, res) => res.json((await conversations(store)).slice(0, 200)));
  app.get('/admin/api/conversations/:sid', async (req, res) => res.json((await store.all('messages')).filter((m) => m.sessionId === req.params.sid).sort((a, b) => a.ts - b.ts)));
  app.get('/admin/api/export.csv', async (_req, res) => {
    const rows = (await store.all('leads')).sort((a, b) => b.ts - a.ts), cols = ['ts', 'kind', 'name', 'email', 'phone', 'message', 'page', 'open', 'consent'];
    res.type('text/csv').send([cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(c === 'ts' ? new Date(r.ts).toISOString() : r[c])).join(','))].join('\n'));
  });
  app.post('/admin/api/kb/refresh', async (_req, res) => { try { res.json(await refreshKb()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.delete('/admin/api/subject', async (req, res) => {
    const email = req.query.email || req.body?.email;
    const r = email && (await deleteSubject(store, email));
    r ? res.json(r) : res.status(400).json({ error: 'email required' });
  });
}
