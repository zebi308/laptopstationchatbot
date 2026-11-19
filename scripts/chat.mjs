// Quick terminal test of the full chat flow:  npm run chat -- "show me ASUS laptops under 600"
import 'dotenv/config';
const base = process.env.CHAT_URL || `http://localhost:${process.env.PORT || 3000}`;
const origin = (process.env.ALLOWED_ORIGINS || '').split(',')[0]?.trim() || 'http://localhost:3000';
const msg = process.argv.slice(2).join(' ') || 'Show me an ASUS laptop under 600';
const H = { 'Content-Type': 'application/json', Origin: origin };
const s = await (await fetch(`${base}/api/session`, { method: 'POST', headers: H, body: '{}' })).json();
const r = await fetch(`${base}/api/chat-stream`, { method: 'POST', headers: { ...H, Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ messages: [{ role: 'user', content: msg }] }) });
if (!r.ok) { console.error(`HTTP ${r.status}`, await r.text()); process.exit(1); }
let buf = '', text = '';
for await (const chunk of r.body) {
  buf += Buffer.from(chunk).toString('utf8');
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data:')); buf = buf.slice(i + 2);
    if (!line) continue;
    const ev = JSON.parse(line.slice(5));
    if (ev.type === 'status') console.log(`  [${ev.text}]`);
    else if (ev.type === 'text') text += ev.text;
    else if (ev.type === 'cards') ev.products.forEach((p) => console.log(`  [card] ${p.title} — ${p.currency} ${p.variants[0].price}${p.condition ? ` — ${p.condition.label}` : ''}`));
    else if (ev.type === 'form') console.log(`  [contact form shown: ${ev.kind}, team ${ev.open ? 'open' : 'closed'}]`);
    else if (ev.type === 'action') console.log(`  [browser action: ${ev.action} variant ${ev.variantId}]`);
    else if (ev.type === 'error') console.log(`  [ERROR] ${ev.message}`);
  }
}
console.log(`\n${text}\n`);
