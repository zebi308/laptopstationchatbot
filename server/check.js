// `npm run check`: tells you exactly which layer is broken (config, store data, AI key, operations).
import 'dotenv/config';
import { searchProducts } from './shopify.js';
import { providerName, modelName, keyPresent, ping } from './llm.js';
import { loadKb, kbStats } from './kb/search.js';
import { hoursStatus } from './hours.js';
import * as sec from './security.js';

let failed = false, warned = 0;
const ok = (m) => console.log('  PASS ', m);
const warn = (m, hint) => { warned++; console.log('  WARN ', m); if (hint) console.log('        →', hint); };
const bad = (m, hint) => { failed = true; console.log('  FAIL ', m); if (hint) console.log('        →', hint); };
const e = process.env;

console.log('\n1) Config');
console.log(`   provider=${providerName()}  model=${modelName()}`);
keyPresent() ? ok('API key is set') : bad('API key missing', `Set ${providerName() === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} in .env (no quotes, no spaces) and restart.`);
console.log(`   products source: ${e.SHOPIFY_STOREFRONT_TOKEN ? 'Storefront API' : `public catalogue at ${e.SHOPIFY_PUBLIC_URL || '(SHOPIFY_PUBLIC_URL not set!)'}`}`);
/your-store|yourdomain|your-live-domain/.test(e.ALLOWED_ORIGINS || '') || !e.ALLOWED_ORIGINS ? bad('ALLOWED_ORIGINS is empty or still a placeholder', 'List your storefront origins, e.g. https://laptopstation.co.uk,https://www.laptopstation.co.uk') : ok('ALLOWED_ORIGINS set');

console.log('\n2) Store products');
try {
  const items = await searchProducts('laptop', 3);
  items.length ? ok(`found products, e.g. "${items[0].title.slice(0, 60)}" at ${items[0].currency} ${items[0].variants[0].price}`) : bad('connected, but 0 products matched', 'Check SHOPIFY_PUBLIC_URL, and that products are published to the Online Store channel.');
} catch (err) { bad(`could not load products: ${err.message}`, 'Open <SHOPIFY_PUBLIC_URL>/products.json in a private window. If that works, check the URL in .env has https:// and no trailing path.'); }

console.log('\n3) AI model');
if (keyPresent()) {
  try { ok(`model replied: "${await ping()}"`); } catch (err) {
    const s = err.status, msg = String(err.message || err).slice(0, 200);
    bad(`${s || ''} ${msg}`, s === 401 ? 'The API key was rejected. Copy it again from the provider dashboard.' : s === 429 || /quota|credit|billing/i.test(msg) ? 'No credit or rate-limited. API credit is separate from ChatGPT/Claude subscriptions.' : s === 404 || /model/i.test(msg) ? `Model "${modelName()}" isn't available to this account. Set ${providerName() === 'openai' ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL'} to one listed in your dashboard.` : 'See the message above.');
  }
}

console.log('\n4) Operations (warnings do not block testing, but matter before go-live)');
loadKb();
kbStats().chunks ? ok(`knowledge base: ${kbStats().chunks} chunks, ${kbStats().faqs} curated FAQs (built ${kbStats().built})`) : warn('knowledge base is empty', 'Run `npm run kb:build`, then fill in kb/faq.md (replace every <<CONFIRM>>).');
sec.secretIsPersistent() ? ok('SESSION_SECRET set') : warn('SESSION_SECRET not set', 'Set a long random value so sessions survive restarts.');
e.ADMIN_TOKEN ? ok('ADMIN_TOKEN set (dashboard at /admin)') : warn('ADMIN_TOKEN not set', 'The admin dashboard is disabled without it.');
e.RESEND_API_KEY && e.SUPPORT_EMAIL ? ok(`hand-over emails go to ${e.SUPPORT_EMAIL}`) : warn('email notifications not configured', 'Set RESEND_API_KEY, MAIL_FROM and SUPPORT_EMAIL (or HANDOFF_WEBHOOK_URL). Leads are still saved and visible in /admin.');
hoursStatus().configured ? ok(`support hours set (open now: ${hoursStatus().open})`) : warn('SUPPORT_HOURS not set', 'Example: SUPPORT_HOURS="Mon-Fri 09:00-17:30" so out-of-hours messages are accurate.');
e.SHOPIFY_ADMIN_TOKEN || (e.SHOPIFY_CLIENT_ID && e.SHOPIFY_CLIENT_SECRET) ? ok('order lookup credentials set') : warn('order lookup is OFF (no Admin credentials)', 'Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app, scope read_orders).');
e.ABANDON_ENABLED === '1' ? (e.SHOPIFY_WEBHOOK_SECRET || e.SHOPIFY_CLIENT_SECRET ? ok('abandoned-cart messaging enabled') : bad('ABANDON_ENABLED=1 but no webhook secret', 'Set SHOPIFY_WEBHOOK_SECRET (or SHOPIFY_CLIENT_SECRET).')) : ok('abandoned-cart messaging is off (ABANDON_ENABLED not set)');

console.log(failed ? '\nSome checks failed. Fix the FAIL lines above, then run again.\n' : `\nAll required checks passed${warned ? ` (${warned} warning${warned > 1 ? 's' : ''})` : ''}. Run: npm start\n`);
process.exit(failed ? 1 : 0);
