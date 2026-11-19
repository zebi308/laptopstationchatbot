// LLM adapter: the same tool loop on Anthropic (Claude) or OpenAI. Pick with LLM_PROVIDER=openai|anthropic.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { TOOLS, STATUS, runTool } from './tools.js';

const env = process.env;
export const providerName = () => {
  const p = (env.LLM_PROVIDER || '').toLowerCase();
  if (p === 'openai' || p === 'anthropic') return p;
  return env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY ? 'openai' : 'anthropic';
};
export const modelName = () => (providerName() === 'openai' ? env.OPENAI_MODEL || 'gpt-5-mini' : env.ANTHROPIC_MODEL || 'claude-haiku-5-5');
export const keyPresent = () => Boolean(providerName() === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY);

let _a, _o;
const anthropic = () => (_a ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || 'missing' }));
const openai = () => (_o ??= new OpenAI({ apiKey: env.OPENAI_API_KEY || 'missing', baseURL: env.OPENAI_BASE_URL || undefined }));

const OPENAI_TOOLS = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

// Reasoning models (gpt-5*, o-series) need max_completion_tokens and accept reasoning_effort; others ignore/reject it.
function openaiParams(maxTokens) {
  const model = modelName();
  const p = { model, max_completion_tokens: maxTokens };
  const effort = env.OPENAI_REASONING_EFFORT ?? (/^(gpt-5|o\d)/.test(model) ? 'low' : '');
  if (effort && effort !== 'off') p.reasoning_effort = effort;
  return p;
}

export async function runChat({ system, history, send, ctx, signal }) {
  return providerName() === 'openai' ? runOpenAI({ system, history, send, ctx, signal }) : runAnthropic({ system, history, send, ctx, signal });
}

async function runAnthropic({ system, history, send, ctx, signal }) {
  const msgs = [...history];
  let sep = false;
  for (let turn = 0; turn < 6 && !signal.aborted; turn++) {
    const stream = anthropic().messages.stream({ model: modelName(), max_tokens: 900, system, tools: TOOLS, messages: msgs }, { signal });
    stream.on('text', (t) => { if (sep) { send({ type: 'text', text: '\n\n' }); sep = false; } send({ type: 'text', text: t }); });
    const final = await stream.finalMessage();
    if (final.stop_reason !== 'tool_use') return;
    if (final.content.some((b) => b.type === 'text' && b.text.trim())) sep = true;
    msgs.push({ role: 'assistant', content: final.content });
    const results = [];
    for (const u of final.content.filter((b) => b.type === 'tool_use')) {
      send({ type: 'status', text: STATUS[u.name] || 'Working…' });
      const r = await runTool(u.name, u.input || {}, ctx);
      r.events.forEach(send);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, is_error: Boolean(r.isError) });
    }
    msgs.push({ role: 'user', content: results });
  }
}

async function runOpenAI({ system, history, send, ctx, signal }) {
  const msgs = [{ role: 'system', content: system }, ...history];
  let sep = false;
  for (let turn = 0; turn < 6 && !signal.aborted; turn++) {
    const stream = await openai().chat.completions.create(
      { ...openaiParams(Number(env.OPENAI_MAX_TOKENS || 4000)), messages: msgs, tools: OPENAI_TOOLS, stream: true },
      { signal },
    );
    let text = '';
    const calls = [];
    for await (const chunk of stream) {
      const d = chunk.choices?.[0]?.delta;
      if (!d) continue;
      if (d.content) {
        if (sep) { send({ type: 'text', text: '\n\n' }); sep = false; }
        text += d.content;
        send({ type: 'text', text: d.content });
      }
      for (const tc of d.tool_calls || []) {
        const c = (calls[tc.index] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
    const used = calls.filter(Boolean);
    if (!used.length) return;
    if (text.trim()) sep = true;
    msgs.push({ role: 'assistant', content: text || null, tool_calls: used.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) });
    for (const c of used) {
      let input = {};
      try { input = JSON.parse(c.args || '{}'); } catch (_) { /* model sent bad JSON: run with empty input */ }
      send({ type: 'status', text: STATUS[c.name] || 'Working…' });
      const r = await runTool(c.name, input, ctx);
      r.events.forEach(send);
      msgs.push({ role: 'tool', tool_call_id: c.id, content: r.content });
    }
  }
}

// Tiny round-trip used by `npm run check`.
export async function ping() {
  if (providerName() === 'openai') {
    const r = await openai().chat.completions.create({ ...openaiParams(500), messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
    return r.choices?.[0]?.message?.content?.trim() || '(empty reply)';
  }
  const r = await anthropic().messages.create({ model: modelName(), max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
  return r.content.map((b) => b.text || '').join('').trim() || '(empty reply)';
}
