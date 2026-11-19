// Persistence: JSON files by default (DATA_DIR) or Supabase (one table, see README). Same tiny interface:
// add(collection, rec) / all(collection) / update(collection, id, patch) / removeWhere(collection, predicate)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { str, num } from './config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export class FileStore {
  constructor(dir) { this.dir = dir; this.data = {}; this.timers = {}; fs.mkdirSync(dir, { recursive: true }); }
  _load(c) {
    if (!this.data[c]) { try { this.data[c] = JSON.parse(fs.readFileSync(path.join(this.dir, `${c}.json`), 'utf8')); } catch (_) { this.data[c] = []; } }
    return this.data[c];
  }
  _save(c) { clearTimeout(this.timers[c]); this.timers[c] = setTimeout(() => this.flush(c), 150); this.timers[c].unref?.(); }
  flush(c) {
    if (!c) return Object.keys(this.data).forEach((k) => this.flush(k));
    const f = path.join(this.dir, `${c}.json`);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(this.data[c])); fs.renameSync(`${f}.tmp`, f);
  }
  async add(c, rec) { const r = { id: crypto.randomUUID(), ts: Date.now(), ...rec }; this._load(c).push(r); this._save(c); return r; }
  async all(c) { return [...this._load(c)]; }
  async get(c, id) { return this._load(c).find((x) => x.id === id) || null; }
  async find(c, key, value) { return this._load(c).filter((x) => x[key] === value); } // key must be a plain field name
  async update(c, id, patch) { const r = this._load(c).find((x) => x.id === id); if (!r) return null; Object.assign(r, patch); this._save(c); return r; }
  async removeWhere(c, pred) { const a = this._load(c); const keep = a.filter((x) => !pred(x)); const n = a.length - keep.length; this.data[c] = keep; if (n) this._save(c); return n; }
}

export class SupabaseStore {
  constructor(url, key) { this.url = `${url.replace(/\/$/, '')}/rest/v1/ls_records`; this.key = key; }
  h(extra = {}) { // legacy service_role keys are JWTs (send as Bearer too); new sb_secret_ keys go in apikey only
    return { apikey: this.key, ...(this.key.startsWith('sb_') ? {} : { Authorization: `Bearer ${this.key}` }), 'Content-Type': 'application/json', ...extra };
  }
  _row(x) { return { id: x.id, ts: Number(x.ts), ...x.data }; }
  async _req(url, opts) { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`Supabase ${r.status}`); return r; }
  async add(c, rec) { const id = crypto.randomUUID(), ts = Date.now(); await this._req(this.url, { method: 'POST', headers: this.h({ Prefer: 'return=minimal' }), body: JSON.stringify({ id, collection: c, ts, data: rec }) }); return { id, ts, ...rec }; }
  async all(c) {
    const out = [];
    for (let off = 0; ; off += 1000) {
      const rows = await (await this._req(`${this.url}?collection=eq.${encodeURIComponent(c)}&select=id,ts,data&order=ts.asc&limit=1000&offset=${off}`, { headers: this.h() })).json();
      out.push(...rows.map((x) => ({ id: x.id, ts: Number(x.ts), ...x.data })));
      if (rows.length < 1000) break;
    }
    return out;
  }
  async get(c, id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
    const rows = await (await this._req(`${this.url}?collection=eq.${encodeURIComponent(c)}&id=eq.${id}&select=id,ts,data`, { headers: this.h() })).json();
    return rows[0] ? this._row(rows[0]) : null;
  }
  async find(c, key, value) { // indexed lookup on one field of the JSON data
    if (!/^\w+$/.test(key)) throw new Error('bad key');
    const rows = await (await this._req(`${this.url}?collection=eq.${encodeURIComponent(c)}&data-%3E%3E${key}=eq.${encodeURIComponent(value)}&select=id,ts,data&order=ts.asc&limit=1000`, { headers: this.h() })).json();
    return rows.map((x) => this._row(x));
  }
  async update(c, id, patch) {
    const cur = await this.get(c, id); if (!cur) return null;
    const { id: _i, ts: _t, ...data } = { ...cur, ...patch };
    await this._req(`${this.url}?id=eq.${id}`, { method: 'PATCH', headers: this.h({ Prefer: 'return=minimal' }), body: JSON.stringify({ data }) });
    return { ...cur, ...patch };
  }
  async removeWhere(c, pred) {
    const ids = (await this.all(c)).filter(pred).map((x) => x.id);
    for (let i = 0; i < ids.length; i += 50) await this._req(`${this.url}?id=in.(${ids.slice(i, i + 50).join(',')})`, { method: 'DELETE', headers: this.h() });
    return ids.length;
  }
}

export function createStore() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) return new SupabaseStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return new FileStore(str('DATA_DIR', process.env.VERCEL ? '/tmp/ls-data' : path.join(root, 'data')));
}

// Retention: messages/events after RETENTION_DAYS, leads after LEAD_RETENTION_DAYS, old checkouts after 30 days.
export async function runRetention(store, now = Date.now()) {
  const day = 86_400_000, out = {};
  out.messages = await store.removeWhere('messages', (r) => now - r.ts > num('RETENTION_DAYS', 90) * day);
  out.events = await store.removeWhere('events', (r) => now - r.ts > num('RETENTION_DAYS', 90) * day);
  out.leads = await store.removeWhere('leads', (r) => now - r.ts > num('LEAD_RETENTION_DAYS', 365) * day);
  out.handoffs = await store.removeWhere('handoffs', (r) => now - r.ts > num('RETENTION_DAYS', 90) * day);
  out.handoffMessages = await store.removeWhere('handoff_msgs', (r) => now - r.ts > num('RETENTION_DAYS', 90) * day);
  out.checkouts = await store.removeWhere('checkouts', (r) => now - r.ts > 30 * day);
  return out;
}

// GDPR erase: leads for the email, the chats linked to those leads, and abandoned-cart records. Opt-outs are kept on purpose.
export async function deleteSubject(store, email) {
  const e = String(email).trim().toLowerCase();
  if (!e) return null;
  const leads = (await store.all('leads')).filter((l) => (l.email || '').toLowerCase() === e);
  const sessions = new Set(leads.map((l) => l.sessionId));
  return {
    leads: await store.removeWhere('leads', (l) => (l.email || '').toLowerCase() === e),
    messages: await store.removeWhere('messages', (m) => sessions.has(m.sessionId)),
    events: await store.removeWhere('events', (m) => sessions.has(m.sessionId)),
    checkouts: await store.removeWhere('checkouts', (c) => (c.email || '') === e),
  };
}
