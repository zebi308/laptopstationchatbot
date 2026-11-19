// Live hand-over: the visitor chats with your team through a Slack channel.
//   visitor clicks "Chat"  ->  a new Slack message (the thread root) with the transcript so far
//   team replies in that thread  ->  the reply shows up in the widget (the first reply = "joined")
//   team types !end  ->  the visitor goes back to the AI assistant
// Needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL_ID. On Vercel it also needs Supabase (instances do not share memory or disk).
import crypto from 'node:crypto';
import { str, num } from './config.js';
import * as sec from './security.js';
import { hoursStatus } from './hours.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(['waiting', 'active']);

export const liveConfigured = () => Boolean(str('SLACK_BOT_TOKEN') && str('SLACK_CHANNEL_ID') && str('SLACK_SIGNING_SECRET')
  && (!process.env.VERCEL || (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)));
export function liveStatus() {
  const enabled = liveConfigured();
  return { enabled, available: enabled && hoursStatus().open };
}

// ---- Slack helpers
async function slack(method, params) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${str('SLACK_BOT_TOKEN')}` },
    body: new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error || r.status}`);
  return j;
}
const toSlack = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // also stops @channel tricks from visitors
export const fromSlack = (t) => String(t || '')
  .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1').replace(/<(https?:\/\/[^>]+)>/g, '$1')
  .replace(/<[@#!][^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const names = new Map();
async function agentName(uid) {
  if (names.has(uid)) return names.get(uid);
  let n = 'Laptop Station team';
  try { const u = (await slack('users.info', { user: uid })).user; n = String(u.profile?.display_name || u.real_name || u.name || n).split(/\s+/)[0].slice(0, 30) || n; } catch (_) { /* needs users:read; fall back */ }
  names.set(uid, n); return n;
}
const note = (h, text) => slack('chat.postMessage', { channel: str('SLACK_CHANNEL_ID'), thread_ts: h.slackTs, text }).catch((e) => sec.logError('slack-note', e));

export function verifySlack(req) {
  const secret = str('SLACK_SIGNING_SECRET'), ts = req.headers['x-slack-request-timestamp'], sig = String(req.headers['x-slack-signature'] || '');
  if (!secret || !ts || !req.rawBody || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:`).update(req.rawBody).digest('hex')}`;
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

export function mountLive(app, { store, requireSession }) {
  const safe = async (fn) => { try { return await fn(); } catch (e) { sec.logError('live', e); return null; } };
  const addMsg = (h, from, text, extra = {}) => store.add('handoff_msgs', { handoffId: h.id, from, text, ...extra });
  const publicMsg = (m) => ({ id: m.id, ts: m.ts, from: m.from, text: m.text, agent: m.agent || undefined });

  // load a handoff that belongs to this session
  async function own(req, res) {
    const id = String(req.params.id || '');
    const h = UUID.test(id) ? await store.get('handoffs', id) : null;
    if (!h || h.sessionId !== req.sessionId) { res.status(404).json({ error: 'Not found' }); return null; }
    return h;
  }

  // 1) visitor asks for a person
  app.post('/api/handoff/start', requireSession, async (req, res) => {
    if (!liveStatus().enabled) return res.status(503).json({ error: 'unavailable' });
    if (!liveStatus().available) return res.status(409).json({ error: 'closed' });
    if (sec.rateLimited(`handoff:${req.sessionId}`, 5, 3_600_000) || sec.rateLimited(`handoff-ip:${req.ip}`, 20, 3_600_000)) return res.status(429).json({ error: 'Too many requests' });
    try {
      const open = (await store.find('handoffs', 'sessionId', req.sessionId)).filter((x) => ACTIVE.has(x.status)).sort((a, b) => b.ts - a.ts)[0];
      if (open) return res.json({ id: open.id, status: open.status, waitSeconds: num('LIVE_WAIT_SECONDS', 90) });
      const page = String(req.body?.page || '').slice(0, 200);
      const history = (await store.find('messages', 'sessionId', req.sessionId)).sort((a, b) => a.ts - b.ts).slice(-8);
      const recent = history.map((m) => `> *${m.role === 'user' ? 'Customer' : 'Assistant'}:* ${toSlack(String(m.content).replace(/\s+/g, ' ').slice(0, 280))}`).join('\n') || '> _(no chat yet)_';
      const h = await store.add('handoffs', { sessionId: req.sessionId, status: 'waiting', page, slackTs: '', lastSeen: Date.now() });
      let ts;
      try {
        const mention = str('SLACK_MENTION') ? `<!${str('SLACK_MENTION').replace(/[^a-z]/gi, '')}> ` : '';
        ts = (await slack('chat.postMessage', { channel: str('SLACK_CHANNEL_ID'), text: `${mention}:large_green_circle: *New live chat request*\n*Page:* ${toSlack(page || '-')}\n*Visitor:* #${h.id.slice(0, 6)}\n*Recent chat:*\n${recent}\n\n_Reply in this thread to chat with the visitor. Type_ \`!end\` _to finish and hand them back to the AI assistant._` })).ts;
      } catch (e) { sec.logError('slack-post', e); await store.update('handoffs', h.id, { status: 'failed' }); return res.status(502).json({ error: 'unavailable' }); }
      await store.update('handoffs', h.id, { slackTs: ts });
      await safe(() => store.add('events', { name: 'live_request', sessionId: req.sessionId }));
      res.json({ id: h.id, status: 'waiting', waitSeconds: num('LIVE_WAIT_SECONDS', 90) });
    } catch (e) { sec.logError('handoff-start', e); res.status(502).json({ error: 'unavailable' }); }
  });

  // 2) the widget polls for status and new messages
  app.get('/api/handoff/:id/poll', requireSession, async (req, res) => {
    if (sec.rateLimited(`poll:${req.sessionId}`, 180, 60_000)) return res.status(429).json({ error: 'Slow down' });
    try {
      let h = await own(req, res); if (!h) return;
      const patch = {};
      if (h.status === 'waiting' && Date.now() - h.ts > num('LIVE_WAIT_SECONDS', 90) * 1000) {
        Object.assign(patch, { status: 'timeout', endedAt: Date.now(), endReason: 'no_answer' });
        await safe(() => note(h, ':hourglass: No one picked this up in time. The visitor was offered the email form.'));
      }
      if (Date.now() - (h.lastSeen || 0) > 20_000) patch.lastSeen = Date.now(); // throttled: one write per ~20s
      if (Object.keys(patch).length) h = await store.update('handoffs', h.id, patch);
      const after = Number(req.query.after) || 0;
      const msgs = (await store.find('handoff_msgs', 'handoffId', h.id)).filter((m) => m.ts >= after - 2000).sort((a, b) => a.ts - b.ts).map(publicMsg);
      res.json({ status: h.status, agent: h.agent || null, messages: msgs });
    } catch (e) { sec.logError('handoff-poll', e); res.status(502).json({ error: 'unavailable' }); }
  });

  // 3) visitor message -> Slack thread
  app.post('/api/handoff/:id/message', requireSession, async (req, res) => {
    if (sec.rateLimited(`hmsg:${req.sessionId}`, 30, 60_000)) return res.status(429).json({ error: 'Slow down' });
    const text = sec.redact(String(req.body?.text || '').trim().slice(0, 1000));
    if (!text) return res.status(400).json({ error: 'No message' });
    try {
      const h = await own(req, res); if (!h) return;
      if (!ACTIVE.has(h.status)) return res.status(409).json({ error: 'ended', status: h.status });
      const m = await addMsg(h, 'visitor', text);
      await slack('chat.postMessage', { channel: str('SLACK_CHANNEL_ID'), thread_ts: h.slackTs, text: `*Visitor:* ${toSlack(text)}` });
      res.json({ ok: true, id: m.id });
    } catch (e) { sec.logError('handoff-msg', e); res.status(502).json({ error: 'unavailable' }); }
  });

  // 4) visitor cancels (while waiting) or ends (while chatting)
  const finish = (reason, slackText) => async (req, res) => {
    try {
      const h = await own(req, res); if (!h) return;
      if (ACTIVE.has(h.status)) {
        await store.update('handoffs', h.id, { status: reason === 'cancel' ? 'cancelled' : 'ended', endedAt: Date.now(), endReason: reason });
        await safe(() => note(h, slackText));
      }
      res.json({ ok: true });
    } catch (e) { sec.logError('handoff-end', e); res.status(502).json({ error: 'unavailable' }); }
  };
  app.post('/api/handoff/:id/cancel', requireSession, finish('cancel', ':x: The visitor cancelled the request.'));
  app.post('/api/handoff/:id/end', requireSession, finish('visitor', ':wave: The visitor ended the chat.'));

  // 5) Slack -> widget (Events API). Reply in the thread = message to the visitor.
  app.post('/api/slack/events', async (req, res) => {
    const body = req.body || {};
    if (body.type === 'url_verification') { // lets you save the Request URL before the signing secret is set; it only echoes the challenge
      if (str('SLACK_SIGNING_SECRET') && !verifySlack(req)) return res.status(401).end();
      return res.json({ challenge: String(body.challenge || '') });
    }
    if (!liveConfigured() || !verifySlack(req)) return res.status(401).end();
    try {
      const ev = body.event;
      if (body.type !== 'event_callback' || !ev || ev.type !== 'message' || ev.subtype || ev.bot_id || !ev.thread_ts || !ev.user || !ev.text || ev.channel !== str('SLACK_CHANNEL_ID')) return res.sendStatus(200);
      const h = (await store.find('handoffs', 'slackTs', ev.thread_ts))[0];
      if (!h) return res.sendStatus(200);
      if ((await store.find('handoff_msgs', 'slackTs', ev.ts)).length) return res.sendStatus(200); // Slack retry: already handled
      const text = fromSlack(ev.text).slice(0, 1000);
      if (!text) return res.sendStatus(200);

      if (!ACTIVE.has(h.status)) { await note(h, ':warning: The visitor has already left this chat, so your message was not delivered.'); return res.sendStatus(200); }
      if (/^!(end|ai)$/i.test(text)) {
        await store.update('handoffs', h.id, { status: 'ended', endedAt: Date.now(), endReason: 'agent' });
        await addMsg(h, 'system', 'The team ended the live chat. You’re back with the AI assistant.', { slackTs: ev.ts });
        await note(h, ':white_check_mark: Chat ended. The visitor is back with the AI assistant.');
        return res.sendStatus(200);
      }
      let agent = h.agent;
      if (h.status === 'waiting') {
        agent = await agentName(ev.user);
        await store.update('handoffs', h.id, { status: 'active', agent, joinedAt: Date.now() });
        await addMsg(h, 'system', `${agent} joined the chat`);
        await new Promise((r) => setTimeout(r, 3)); // keep "joined" strictly before the first reply
      }
      if (Date.now() - (h.lastSeen || 0) > 120_000) await note(h, ':warning: The visitor may have left (no activity for 2+ minutes). They will see your message if they come back.');
      await addMsg(h, 'agent', text, { agent: agent || 'Laptop Station team', slackTs: ev.ts });
      res.sendStatus(200);
    } catch (e) { sec.logError('slack-event', e); res.sendStatus(500); }
  });
}
