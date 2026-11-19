// Lead / hand-over notification: email via Resend (REST) and/or a webhook (Slack, Make, n8n, Zapier).
import { str } from './config.js';

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });

export function leadText(lead, transcript, open) {
  const t = (transcript || []).slice(-30).map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`).join('\n');
  return [`Type: ${lead.kind === 'human' ? 'Talk to a person' : 'Enquiry'}`, `Name: ${lead.name}`, `Email: ${lead.email}`, `Phone: ${lead.phone || '-'}`,
    `Page: ${lead.page || '-'}`, `Received: ${open ? 'during opening hours' : 'OUT OF HOURS'}`, '', 'Message:', lead.message || '-', '', '--- Chat transcript ---', t || '(no chat yet)'].join('\n');
}

export async function notifyLead({ lead, transcript, open }) {
  const result = { emailed: false, webhooked: false };
  const subject = `[Laptop Station] ${lead.kind === 'human' ? 'Talk-to-a-person request' : 'New enquiry'} from ${lead.name}${open ? '' : ' (out of hours)'}`;
  const text = leadText(lead, transcript, open);
  const key = str('RESEND_API_KEY'), to = str('SUPPORT_EMAIL');
  if (key && to) {
    try { const r = await post(str('RESEND_API_URL', 'https://api.resend.com/emails'), { from: str('MAIL_FROM', 'Laptop Station <onboarding@resend.dev>'), to: [to], subject, text, reply_to: lead.email }, { Authorization: `Bearer ${key}` }); result.emailed = r.ok; if (!r.ok) console.error('[mail] Resend', r.status); } catch (e) { console.error('[mail]', e.message); }
  } else console.log(`[mail] (not configured) ${subject}`);
  const hook = str('HANDOFF_WEBHOOK_URL');
  if (hook) { try { const r = await post(hook, { type: 'lead', subject, lead, transcript: (transcript || []).slice(-30), open, text }); result.webhooked = r.ok; } catch (e) { console.error('[webhook]', e.message); } }
  return result;
}
