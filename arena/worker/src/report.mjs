// Risk report for a proposal. The facts are the reporter's (reporter/src/facts.mjs); the wording comes
// from Qwen3 on Cloudflare Workers AI with the reporter's own prompt and output guard
// (reporter/src/llm.mjs: every figure must come from the facts). If the model is unavailable, slow or
// its output fails the guard, the reporter's template is used instead (template: true, shown as such
// in the UI). The text is hashed exactly like the reporter does: keccak256(utf8(text)); the hash goes
// on chain with attachReason, the full text is kept by the Durable Object for /api/state.
import { keccak256, stringToBytes } from 'viem'
import { buildFacts } from '../../../reporter/src/facts.mjs'
import { buildPrompt, vetOutput } from '../../../reporter/src/llm.mjs'
import { templateReport } from '../../../reporter/src/templates.mjs'

// Qwen3 30B-A3B (MoE, ~3B active): fast enough to finish inside the cooldown; /no_think keeps it out of reasoning mode.
export const AI_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'

// Workers AI models answer either { response } or the OpenAI shape { choices: [{ message: { content } }] };
// take the first non-empty text.
function modelText(out) {
  if (typeof out === 'string') return out
  const c = out?.choices?.[0]
  for (const v of [out?.response, c?.message?.content, c?.text, out?.result?.response]) if (typeof v === 'string' && v.trim()) return v
  return ''
}
const shape = (out) => (typeof out === 'string' ? `string:${out.length}` : Object.keys(out ?? {}).join(',')).slice(0, 80)

export async function makeReport(sim, proposal, { decimals = 8, symbol = 'dBTC', ai = null, timeoutMs = 9000 } = {}) {
  const facts = buildFacts(sim, proposal, { decimals, symbol })
  let text = null
  let model = null
  let fallbackReason = ai ? null : 'no_ai_binding'
  let ms = null
  if (ai) {
    const t0 = Date.now()
    let timer
    try {
      const prompt = buildPrompt(facts)
      const out = await Promise.race([
        ai.run(AI_MODEL, {
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: `${prompt.user} /no_think` },
          ],
          max_tokens: 400,
          temperature: 0.7,
          top_p: 0.8,
          chat_template_kwargs: { enable_thinking: false },
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        }),
      ])
      const v = vetOutput(modelText(out), prompt)
      if (v.ok) {
        text = v.text
        model = AI_MODEL
      } else fallbackReason = `${v.reason} [${shape(out)}] ${String(v.text).slice(0, 40)}`
    } catch (e) {
      fallbackReason = String(e?.message ?? e).slice(0, 120)
    } finally {
      clearTimeout(timer)
    }
    ms = Date.now() - t0
    console.log(`report #${proposal?.id}: ${text === null ? 'template (' + fallbackReason + ')' : 'workers-ai'} ${ms} ms`)
  }
  const template = text === null
  if (template) text = templateReport(facts)
  return { text, hash: keccak256(stringToBytes(text)), template, model, fallbackReason, ms, rule: facts.ruleId }
}
