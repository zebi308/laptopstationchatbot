// Session tokens, rate limits, daily AI budget, redaction, recent-error log.
import crypto from 'node:crypto';
import { num } from './config.js';

let generated;
// On Vercel every instance needs the same secret, so derive a stable one from other secrets if SESSION_SECRET is unset.
const derived = () => { const b = process.env.ADMIN_TOKEN || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY; return b ? crypto.createHash('sha256').update('ls-session:' + b).digest('hex') : null; };
const secret = () => process.env.SESSION_SECRET || (process.env.VERCEL && derived()) || (generated ??= crypto.randomBytes(32).toString('hex'));
export const secretIsPersistent = () => Boolean(process.env.SESSION_SECRET || (process.env.VERCEL && derived()));
const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

export function signToken(sid, ttlMs) {
  const body = Buffer.from(`${sid}.${Date.now() + ttlMs}`).toString('base64url');
  return `${body}.${sign(body)}`;
}
export function verifyToken(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [sid, until] = Buffer.from(body, 'base64url').toString().split('.');
  return Number(until) > Date.now() ? sid : null;
}

const buckets = new Map();
export function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k); }, 60_000).unref();

let day = { d: '', n: 0 };
export function spendBudget() {
  const d = new Date().toISOString().slice(0, 10);
  if (day.d !== d) day = { d, n: 0 };
  if (day.n >= num('DAILY_MESSAGE_CAP', 3000)) return false;
  day.n++;
  return true;
}
export const budgetUsed = () => ({ ...day, cap: num('DAILY_MESSAGE_CAP', 3000) });

export const redact = (t) => String(t).replace(/\b(?:\d[ -]?){13,19}\b/g, '[card number removed]');

const errors = [];
export function logError(where, e) { errors.push({ ts: Date.now(), where, message: String(e?.message || e).slice(0, 200) }); if (errors.length > 20) errors.shift(); }
export const recentErrors = () => [...errors];
