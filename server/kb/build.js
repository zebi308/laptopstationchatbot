// Builds kb/index.json from: the live website (sitemap + policy pages), files in kb/files, and the curated kb/faq.md.
//   npm run kb:build        (also runs automatically on a schedule when KB_SITE_URL is set)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cheerio from 'cheerio';
import { str, num, list } from '../config.js';
import { kbPath, loadKb } from './search.js';

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UA = 'LaptopStationKB/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLICIES = ['/policies/refund-policy', '/policies/shipping-policy', '/policies/privacy-policy', '/policies/terms-of-service', '/policies/contact-information'];
const PLACEHOLDER = /<<\s*CONFIRM/i;

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml' }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

async function sitemapUrls(site, warnings) {
  const include = new RegExp(str('KB_SITEMAP_INCLUDE', 'page|blog'), 'i'), urls = [];
  try {
    const xml = await get(`${site}/sitemap.xml`);
    if (/<sitemapindex/i.test(xml)) { for (const s of locs(xml).filter((u) => include.test(u))) { try { urls.push(...locs(await get(s))); } catch (e) { warnings.push(`sitemap: ${e.message}`); } } } else urls.push(...locs(xml));
  } catch (e) { warnings.push(`sitemap.xml: ${e.message}`); }
  return urls;
}

export function extractPage(html) {
  const $ = cheerio.load(html);
  const title = ($('h1').first().text() || $('title').text() || '').replace(/\s+/g, ' ').trim();
  $('script,style,noscript,nav,header,footer,form,svg,iframe,template,[role=navigation],[aria-hidden=true],.visually-hidden').remove();
  let root_ = $('main').first();
  if (!root_.length) root_ = $('[role=main],#MainContent,.main-content,article').first();
  if (!root_.length) root_ = $('body');
  const sel = 'h1,h2,h3,h4,p,li,tr,dt,dd,blockquote', blocks = [];
  root_.find(sel).each((_, el) => {
    const $el = $(el);
    if ($el.find(sel).length) return; // leaf blocks only (avoids duplicated nested text)
    const text = el.name === 'tr' ? $el.find('th,td').map((__, c) => $(c).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).join(' | ') : $el.text().replace(/\s+/g, ' ').trim();
    if (text.length >= 2) blocks.push({ h: /^h[1-4]$/.test(el.name), t: text });
  });
  return { title, blocks };
}

export function chunkBlocks(blocks, { title, url, kind = 'page' }, maxWords = 350) {
  const out = []; let heading = '', buf = [], words = 0;
  const flush = () => { if (buf.length) out.push({ kind, title: heading ? `${title} > ${heading}` : title, url, text: buf.join('\n') }); buf = []; words = 0; };
  for (const b of blocks) {
    if (b.h) { flush(); heading = b.t === title ? '' : b.t; continue; }
    const w = b.t.split(/\s+/).length;
    if (words + w > maxWords) flush();
    buf.push(b.t); words += w;
  }
  flush();
  return out;
}

const textBlocks = (txt) => txt.split(/\n\s*\n/).map((t) => ({ h: false, t: t.replace(/\s+/g, ' ').trim() })).filter((b) => b.t.length >= 2);

export function parseFaq(md) {
  return md.split(/^##\s*Q:\s*/m).slice(1).map((part) => {
    const [q, ...rest] = part.split('\n');
    let a = rest.join('\n').trim().replace(/^A:\s*/i, '');
    const src = a.match(/^Source:\s*(\S+)\s*$/im); if (src) a = a.replace(src[0], '').trim();
    return { q: q.trim(), a, url: src ? src[1] : null };
  }).filter((f) => f.q && f.a);
}

export async function buildKb({ siteUrl = str('KB_SITE_URL', str('SHOPIFY_PUBLIC_URL')), out = kbPath() } = {}) {
  const warnings = [], chunks = [];
  const site = siteUrl.replace(/\/$/, '');
  let pages = 0, files = 0;
  if (site) {
    const urls = [...new Set([...(await sitemapUrls(site, warnings)), ...POLICIES.map((p) => site + p), ...list('KB_EXTRA_URLS')])].slice(0, num('KB_MAX_PAGES', 80));
    for (const url of urls) {
      try {
        const { title, blocks } = extractPage(await get(url));
        const cs = chunkBlocks(blocks, { title: title || url, url });
        if (cs.length) { chunks.push(...cs); pages++; }
      } catch (e) { if (!/\/policies\//.test(url)) warnings.push(e.message); }
      await sleep(num('KB_DELAY_MS', 150));
    }
  } else warnings.push('KB_SITE_URL not set: website crawl skipped');
  const dir = str('KB_FILES_DIR', path.join(root, 'kb', 'files'));
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, f), ext = path.extname(f).toLowerCase(), title = path.basename(f, ext).replace(/[-_]+/g, ' ');
    try {
      let blocks;
      if (ext === '.md' || ext === '.txt') blocks = textBlocks(fs.readFileSync(p, 'utf8'));
      else if (ext === '.html' || ext === '.htm') blocks = extractPage(fs.readFileSync(p, 'utf8')).blocks;
      else if (ext === '.pdf') blocks = textBlocks((await run('pdftotext', ['-layout', p, '-'], { maxBuffer: 20e6 })).stdout);
      else continue;
      chunks.push(...chunkBlocks(blocks, { title, url: null, kind: 'file' })); files++;
    } catch (e) { warnings.push(`${f}: ${ext === '.pdf' ? 'pdftotext not available or failed (convert to .txt)' : e.message}`); }
  }
  let faqs = [];
  const faqFile = str('KB_FAQ_FILE', path.join(root, 'kb', 'faq.md'));
  if (fs.existsSync(faqFile)) {
    const all = parseFaq(fs.readFileSync(faqFile, 'utf8'));
    faqs = all.filter((f) => !PLACEHOLDER.test(`${f.q} ${f.a}`));
    if (faqs.length < all.length) warnings.push(`${all.length - faqs.length} FAQ answer(s) still contain <<CONFIRM>> placeholders and were NOT included`);
    faqs.forEach((f) => chunks.push({ kind: 'faq', title: f.q, url: f.url, text: f.a }));
  }
  const kept = chunks.filter((c) => !PLACEHOLDER.test(c.text));
  const index = { built: new Date().toISOString(), siteUrl: site, stats: { pages, files, warnings }, chunks: kept.map((c, i) => ({ id: i, ...c })), faqs };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.tmp`, JSON.stringify(index)); fs.renameSync(`${out}.tmp`, out);
  loadKb(out);
  return { chunks: index.chunks.length, faqs: faqs.length, pages, files, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config');
  buildKb().then((r) => { console.log(`Knowledge base built: ${r.chunks} chunks from ${r.pages} pages, ${r.files} files, ${r.faqs} curated FAQs.`); r.warnings.forEach((w) => console.log(`  warning: ${w}`)); }).catch((e) => { console.error(e); process.exit(1); });
}
