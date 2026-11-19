// Knowledge-base retrieval: BM25 over chunks in kb/index.json (built by `npm run kb:build`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const kbPath = () => process.env.KB_INDEX || path.join(root, 'kb', 'index.json');

const STOP = new Set('a an the and or of to in on for with is are was were be do does did i you your we our it this that can how what when where which who my me at by from as if not no yes have has any please sell sells buy get want need like know tell about offer stock'.split(' '));
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 4 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const tok = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w)).map(stem);
const SYN = [['return', 'refund', 'exchange', 'sendback', 'cancel'], ['warranty', 'guarantee', 'covered', 'cover'], ['delivery', 'shipping', 'postage', 'dispatch', 'courier', 'deliver'],
  ['klarna', 'clearpay', 'finance', 'instalment', 'installment', 'paylater', 'credit'], ['setup', 'install', 'configure'], ['grade', 'condition', 'refurbished', 'refurb'], ['contact', 'phone', 'email', 'call']]
  .map((g) => g.map((w) => stem(w)));
const synOf = new Map();
SYN.forEach((g) => g.forEach((w) => synOf.set(w, g)));

let idx = { built: null, chunks: [], faqs: [], docs: [], df: new Map(), avg: 1, siteUrl: '', stats: {} };

export function loadKb(file = kbPath()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { idx = { built: null, chunks: [], faqs: [], docs: [], df: new Map(), avg: 1, siteUrl: '', stats: {} }; return idx; }
  const docs = raw.chunks.map((c) => tok(`${c.title} ${c.title} ${c.text}`));
  const df = new Map();
  docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  idx = { built: raw.built, chunks: raw.chunks, faqs: raw.faqs || [], docs, df, avg: docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1) || 1, siteUrl: raw.siteUrl, stats: raw.stats || {} };
  return idx;
}

const PHRASES = [[/\b(send|give|take|post)\s+(it\s+|them\s+|this\s+)?back\b/gi, ' return '], [/\bmoney\s+back\b/gi, ' refund ']];
export function searchKb(query, k = 4) {
  if (!idx.chunks.length) return [];
  const q = new Set();
  tok(PHRASES.reduce((s, [re, to]) => s.replace(re, to), String(query))).forEach((t) => (synOf.get(t) || [t]).forEach((x) => q.add(x)));
  const N = idx.chunks.length, k1 = 1.5, b = 0.75;
  const scored = idx.chunks.map((c, i) => {
    const d = idx.docs[i]; const tf = new Map(); d.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    let s = 0;
    for (const t of q) { const f = tf.get(t); if (!f) continue; const n = idx.df.get(t) || 0; s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / idx.avg))); }
    return { c, s: s * (c.kind === 'faq' ? 1.3 : 1) };
  }).filter((x) => x.s > 0).sort((a, b2) => b2.s - a.s).slice(0, k);
  return scored.map(({ c, s }) => ({ title: c.title, url: c.url, kind: c.kind, text: c.text, score: Math.round(s * 100) / 100 }));
}

export const kbStats = () => ({ built: idx.built, chunks: idx.chunks.length, faqs: idx.faqs.length, siteUrl: idx.siteUrl, ...idx.stats });
export const kbFaqs = () => idx.faqs;
