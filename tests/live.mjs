// Live chat (Slack) flow test. Slack is simulated by replacing fetch for slack.com. Run: node tests/live.mjs
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-live-'));
Object.assign(process.env, { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: 'sek', SLACK_CHANNEL_ID: 'C123', SUPPORT_HOURS: 'Mon-Sun 00:00-23:59', LIVE_WAIT_SECONDS: '90', ADMIN_TOKEN: 'adm', SESSION_SECRET: 'x'.repeat(32), REQUIRE_SESSION: 'true' });
delete process.env.VERCEL; delete process.env.SUPABASE_URL;

const posted = []; let tsCounter = 1000;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://slack.com/api/')) {
    const method = u.split('/api/')[1], p = Object.fromEntries(new URLSearchParams(opts.body));
    if (method === 'chat.postMessage') { const ts = `${++tsCounter}.0001`; posted.push({ ...p, ts }); return Response.json({ ok: true, ts }); }
    if (method === 'users.info') return Response.json({ ok: true, user: { name: 'zohaib', real_name: 'Zohaib Rafique', profile: { display_name: 'Adam' } } });
    return Response.json({ ok: false, error: 'unknown' });
  }
  return realFetch(url, opts);
};

const { app } = await import('../server/app.js');
const server = app.listen(0); const base = `http://localhost:${server.address().port}`;
let pass = 0, fail = 0;
const ok = (c, name, extra) => { c ? pass++ : (fail++, console.log('FAIL', name, extra ?? '')); };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

const session = async () => (await J(await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).body;
const call = async (tok, p, method = 'GET', body) => J(await fetch(base + p, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
const slackEvent = async (event, { sign = true, ts = Math.floor(Date.now() / 1000), secret = 'sek' } = {}) => {
  const raw = JSON.stringify({ type: 'event_callback', event });
  const sig = sign ? `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}` : 'v0=bad';
  return (await fetch(`${base}/api/slack/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig }, body: raw })).status;
};

// config exposes live availability
const cfg = (await J(await fetch(`${base}/api/config`))).body;
ok(cfg.live?.enabled && cfg.live?.available, 'config.live available during hours', cfg.live);

// start
const s1 = await session();
const st = await call(s1.token, '/api/handoff/start', 'POST', { page: '/products/x' });
ok(st.status === 200 && st.body.status === 'waiting' && st.body.id, 'start creates a waiting handoff', st);
ok(posted.length === 1 && /New live chat request/.test(posted[0].text) && posted[0].channel === 'C123', 'start posts to Slack');
const id = st.body.id, root = posted[0].ts;
ok((await call(s1.token, '/api/handoff/start', 'POST', {})).body.id === id, 'start is idempotent for the same session');
ok(posted.length === 1, 'idempotent start does not double-post');

// someone else cannot read it
const s2 = await session();
ok((await call(s2.token, `/api/handoff/${id}/poll`)).status === 404, 'other sessions cannot poll');

// poll while waiting
let p = await call(s1.token, `/api/handoff/${id}/poll?after=0`);
ok(p.body.status === 'waiting' && p.body.messages.length === 0, 'poll waiting', p.body);

// visitor message while waiting goes to the thread (with Slack escaping)
const vm = await call(s1.token, `/api/handoff/${id}/message`, 'POST', { text: 'Hi <!channel> is anyone there? 4111 1111 1111 1111' });
ok(vm.status === 200, 'visitor message accepted');
const last = posted.at(-1);
ok(last.thread_ts === root && last.text.includes('&lt;!channel&gt;') && !last.text.includes('4111'), 'visitor text escaped + redacted in Slack', last.text);

// Slack signature rules
ok(await slackEvent({ type: 'message', user: 'U1', text: 'hello', ts: '2000.1', thread_ts: root, channel: 'C123' }, { sign: false }) === 401, 'bad signature rejected');
ok(await slackEvent({ type: 'message', user: 'U1', text: 'hello', ts: '2000.1', thread_ts: root, channel: 'C123' }, { ts: 1 }) === 401, 'old timestamp rejected');
ok((await fetch(`${base}/api/slack/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'url_verification', challenge: 'abc' }) })).status === 401, 'unsigned url_verification rejected when secret set');

// ignored events
ok(await slackEvent({ type: 'message', user: 'U1', text: 'x', ts: '2000.2', channel: 'C123' }) === 200, 'non-thread message ignored');
ok(await slackEvent({ type: 'message', bot_id: 'B1', text: 'x', ts: '2000.3', thread_ts: root, channel: 'C123' }) === 200, 'bot message ignored');
ok(await slackEvent({ type: 'message', user: 'U1', text: 'x', ts: '2000.4', thread_ts: root, channel: 'COTHER' }) === 200, 'other channel ignored');
p = await call(s1.token, `/api/handoff/${id}/poll?after=0`);
ok(p.body.status === 'waiting', 'ignored events do not change state', p.body);

// agent replies: first reply joins
ok(await slackEvent({ type: 'message', user: 'U1', text: 'Hi! <@U9> check <https://x.co|this>  &amp; more', ts: '2000.5', thread_ts: root, channel: 'C123' }) === 200, 'agent reply accepted');
p = await call(s1.token, `/api/handoff/${id}/poll?after=0`);
const kinds = p.body.messages.map((m) => m.from);
ok(p.body.status === 'active' && p.body.agent === 'Adam', 'agent joined with display name', p.body);
ok(kinds.join() === 'visitor,system,agent', 'message order: visitor, joined, agent', kinds);
ok(p.body.messages.find((m) => m.from === 'agent').text === 'Hi!  check this (https://x.co)  & more', 'Slack markup cleaned', p.body.messages);
ok(p.body.messages.find((m) => m.from === 'system').text === 'Adam joined the chat', 'joined system message');

// duplicate Slack delivery (retry) is ignored
await slackEvent({ type: 'message', user: 'U1', text: 'Hi! again', ts: '2000.5', thread_ts: root, channel: 'C123' });
p = await call(s1.token, `/api/handoff/${id}/poll?after=0`);
ok(p.body.messages.filter((m) => m.from === 'agent').length === 1, 'retries are deduplicated');

// second agent message + polling with after cursor
await slackEvent({ type: 'message', user: 'U1', text: 'How can I help?', ts: '2000.6', thread_ts: root, channel: 'C123' });
const cursor = p.body.messages.at(-1).ts;
p = await call(s1.token, `/api/handoff/${id}/poll?after=${cursor}`);
ok(p.body.messages.some((m) => m.text === 'How can I help?'), 'cursor poll returns new agent message', p.body.messages);

// visitor message when active
ok((await call(s1.token, `/api/handoff/${id}/message`, 'POST', { text: 'Need a laptop' })).status === 200, 'visitor message while active');

// agent ends
ok(await slackEvent({ type: 'message', user: 'U1', text: '!end', ts: '2000.7', thread_ts: root, channel: 'C123' }) === 200, '!end accepted');
p = await call(s1.token, `/api/handoff/${id}/poll?after=0`);
ok(p.body.status === 'ended' && p.body.messages.at(-1).from === 'system' && /AI assistant/.test(p.body.messages.at(-1).text), '!end returns visitor to AI', p.body);
ok((await call(s1.token, `/api/handoff/${id}/message`, 'POST', { text: 'hello?' })).status === 409, 'visitor message after end rejected');
const before = posted.length;
await slackEvent({ type: 'message', user: 'U1', text: 'still here?', ts: '2000.8', thread_ts: root, channel: 'C123' });
ok(posted.length === before + 1 && /not delivered/.test(posted.at(-1).text), 'late agent reply gets a "not delivered" note');

// new request after end works
const again = await call(s1.token, '/api/handoff/start', 'POST', {});
ok(again.status === 200 && again.body.id !== id, 'a new handoff can start after the old one ended');

// cancel
const c = await call(s1.token, `/api/handoff/${again.body.id}/cancel`, 'POST');
ok(c.status === 200 && (await call(s1.token, `/api/handoff/${again.body.id}/poll`)).body.status === 'cancelled', 'visitor can cancel');
ok(/cancelled/.test(posted.at(-1).text), 'cancel is noted in Slack');

// timeout
const s3 = await session();
const t3 = await call(s3.token, '/api/handoff/start', 'POST', {});
const { store } = await import('../server/app.js');
await store.update('handoffs', t3.body.id, { ts: Date.now() - 200_000 });
ok((await call(s3.token, `/api/handoff/${t3.body.id}/poll`)).body.status === 'timeout', 'unanswered request times out');
ok(/No one picked/.test(posted.at(-1).text), 'timeout is noted in Slack');

// visitor ends active chat
const s4 = await session();
const t4 = await call(s4.token, '/api/handoff/start', 'POST', {});
await slackEvent({ type: 'message', user: 'U1', text: 'hi', ts: '3000.1', thread_ts: posted.at(-1).ts, channel: 'C123' });
await call(s4.token, `/api/handoff/${t4.body.id}/end`, 'POST');
ok((await call(s4.token, `/api/handoff/${t4.body.id}/poll`)).body.status === 'ended', 'visitor can end an active chat');

// closed hours -> 409 and config says unavailable
process.env.SUPPORT_HOURS = 'Mon-Sun 00:00-00:01';
const s5 = await session();
const closed = await call(s5.token, '/api/handoff/start', 'POST', {});
const cfg2 = (await J(await fetch(`${base}/api/config`))).body;
ok(closed.status === 409 && closed.body.error === 'closed', 'start refused out of hours', closed);
ok(cfg2.live.enabled && !cfg2.live.available, 'config shows live chat closed out of hours', cfg2.live);
process.env.SUPPORT_HOURS = 'Mon-Sun 00:00-23:59';

// Slack failure -> 502 so the widget can fall back to email
const realF = globalThis.fetch; globalThis.fetch = async (u, o) => (String(u).includes('slack.com') ? Response.json({ ok: false, error: 'invalid_auth' }) : realF(u, o));
const s6 = await session();
ok((await call(s6.token, '/api/handoff/start', 'POST', {})).status === 502, 'Slack failure returns 502');
globalThis.fetch = realF;

// not configured -> disabled
const keep = process.env.SLACK_BOT_TOKEN; delete process.env.SLACK_BOT_TOKEN;
ok(!(await J(await fetch(`${base}/api/config`))).body.live.enabled, 'live chat disabled when Slack is not configured');
ok((await call(s1.token, '/api/handoff/start', 'POST', {})).status === 503, 'start returns 503 when disabled');
process.env.SLACK_BOT_TOKEN = keep;

// admin sees them
const adm = await J(await fetch(`${base}/admin/api/stats`, { headers: { Authorization: 'Bearer adm' } }));
ok(adm.body.liveChats?.total >= 4 && adm.body.liveChats.answered >= 2 && adm.body.liveChats.missed >= 1, 'admin stats count live chats', adm.body.liveChats);

console.log(`live chat: ${pass} passed · ${fail} failed`);
server.close(); process.exit(fail ? 1 : 0);
