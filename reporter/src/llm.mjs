// Local LM Studio client (OpenAI-compatible). Thinking is disabled by prefilling an
// empty think block, because LM Studio silently drops enable_thinking-style flags.
// The model only words the report; every figure is supplied in the prompt.

const SYSTEM = [
  '你是智能合约升级风控助手，为多签签署人写一段风险摘要。',
  '要求：只用简体中文；只写 2 到 3 句，合计不超过 110 个汉字；',
  '依次说明发生了什么、为什么危险（放行时说明为什么放行以及仍需注意什么）、建议多签怎么做；',
  '只能原样引用【事实】里出现的数字和地址，不得自行计算、换算或编造任何数字；',
  '不得使用“绝对安全”之类的绝对化措辞；不得推测攻击者身份；',
  '不要输出标题、列表、引号或 Markdown，直接输出正文。',
].join('');

export function buildPrompt(facts) {
  const user = `【事实】\n${facts.lines.join('\n')}\n\n请写这段风险摘要。`;
  return {
    system: SYSTEM,
    user,
    // Raw Qwen chat template with a pre-closed (empty) think block.
    raw:
      `<|im_start|>system\n${SYSTEM}<|im_end|>\n` +
      `<|im_start|>user\n${user}<|im_end|>\n` +
      `<|im_start|>assistant\n<think>\n\n</think>\n\n`,
  };
}

const BANNED = [/绝对安全/, /百分之百安全/, /100\s*%\s*安全/, /万无一失/, /毫无风险/, /没有任何风险/];
const IDENTITY = [/攻击者(?:是|为|可能是|疑似|来自|应该是)/, /黑客组织/, /Lazarus/i, /朝鲜/, /内鬼/];

function numbersIn(s) {
  return (s.replace(/(?<=\d),(?=\d{3})/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ''));
}

/** Clean model output and reject anything that breaks the report rules. */
export function vetOutput(text, prompt, { finishedByLength = false } = {}) {
  let t = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\/?think>/g, '')
    .replace(/<\|im_(?:start|end)\|>/g, '')
    .replace(/^[\s#>*\-•]+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s*\n+\s*/g, '')
    .trim();
  if (finishedByLength && !/[。！？]$/.test(t)) {
    const cut = Math.max(t.lastIndexOf('。'), t.lastIndexOf('！'), t.lastIndexOf('？'));
    t = cut > 0 ? t.slice(0, cut + 1) : '';
  }
  if (t.length < 12) return { ok: false, reason: 'too_short', text: t };
  if (!/[一-鿿]/.test(t)) return { ok: false, reason: 'not_chinese', text: t };
  if (BANNED.some((re) => re.test(t))) return { ok: false, reason: 'banned_phrase', text: t };
  if (IDENTITY.some((re) => re.test(t))) return { ok: false, reason: 'identity_speculation', text: t };
  const allowed = new Set([...numbersIn(prompt.user), ...numbersIn(prompt.system)]);
  for (let i = 0; i <= 10; i++) allowed.add(String(i));
  const stray = numbersIn(t).filter((n) => !allowed.has(n));
  if (stray.length) return { ok: false, reason: `unsupported_number:${stray.slice(0, 3).join(',')}`, text: t };
  return { ok: true, text: t };
}

export class LmStudio {
  constructor(cfg, log = console.log) {
    this.cfg = cfg;
    this.log = log;
    this.model = cfg.model || null;
    this.lastError = null;
    this.lastOk = null;
    this.queue = Promise.resolve();
  }

  async detectModel() {
    if (this.model) return this.model;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/v1/models`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ids = ((await res.json())?.data ?? []).map((m) => String(m.id));
      // Qwen3.8-27B first, then any Qwen3.8; among several builds the shortest id (the plain one).
      const pick = (re) => ids.filter((id) => re.test(id)).sort((a, b) => a.length - b.length)[0];
      const found = pick(/qwen3[._-]?8.*27b/i) ?? pick(/qwen3[._-]?8/i) ?? null;
      if (!found) throw new Error('no Qwen3.8 model found; set LLM_MODEL');
      this.model = found;
      this.log(`[reporter] LM Studio model: ${found}`);
      return found;
    } finally {
      clearTimeout(t);
    }
  }

  /** Fire-and-forget warm-up: opens the keep-alive connection and JIT-loads the model. */
  async warmup() {
    try {
      const model = await this.detectModel();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 60000);
      const t0 = Date.now();
      const res = await fetch(`${this.cfg.baseUrl}/v1/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: '<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      await res.text();
      this.log(`[reporter] LM Studio warm-up ${res.ok ? 'ok' : 'HTTP ' + res.status} in ${Date.now() - t0} ms`);
    } catch (e) {
      this.lastError = e.cause?.code ?? e.message;
      this.log(`[reporter] LM Studio warm-up skipped: ${this.lastError} (template reports will be used)`);
    }
  }

  /**
   * Stream one report. Serialized: one generation at a time (time spent waiting
   * counts against the caller's deadline).
   * @returns {Promise<{ok:boolean, text?:string, reason?:string, tokens:number, firstTokenMs:number|null, ms:number}>}
   */
  generate(prompt, { deadline, onToken }) {
    const run = () => this.#generate(prompt, { deadline, onToken });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async #generate(prompt, { deadline, onToken }) {
    const c = this.cfg;
    const t0 = Date.now();
    const out = { ok: false, tokens: 0, firstTokenMs: null, ms: 0 };
    if (deadline - t0 < c.minBudgetMs) return { ...out, reason: 'no_budget' };
    let model;
    try {
      model = await this.detectModel();
    } catch (e) {
      this.lastError = e.cause?.code ?? e.message;
      return { ...out, reason: `unavailable:${this.lastError}`, ms: Date.now() - t0 };
    }
    const ctrl = new AbortController();
    let abortReason = null;
    const abort = (why) => {
      if (!abortReason) abortReason = why;
      ctrl.abort();
    };
    const hard = setTimeout(() => abort('timeout'), Math.max(0, deadline - Date.now()));
    const first = setTimeout(() => abort('first_token_timeout'), Math.min(c.firstTokenMs, Math.max(0, deadline - Date.now())));
    let text = '';
    let finish = null;
    try {
      const body =
        c.api === 'chat'
          ? {
              model,
              messages: [
                { role: 'system', content: prompt.system },
                { role: 'user', content: prompt.user },
                { role: 'assistant', content: '<think>\n\n</think>\n\n' },
              ],
            }
          : { model, prompt: prompt.raw };
      Object.assign(body, {
        max_tokens: c.maxTokens,
        temperature: 0.7,
        top_p: 0.8,
        top_k: 20,
        presence_penalty: 1.5,
        stop: ['<|im_end|>', '<|endoftext|>', '<|im_start|>'],
        stream: true,
      });
      const res = await fetch(`${c.baseUrl}${c.api === 'chat' ? '/v1/chat/completions' : '/v1/completions'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
      const decoder = new TextDecoder();
      let buf = '';
      let firstAt = null;
      outer: for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') break outer;
          let j;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const ch = j?.choices?.[0];
          const delta = ch?.text ?? ch?.delta?.content ?? '';
          if (ch?.finish_reason) finish = ch.finish_reason;
          if (!delta) continue;
          if (firstAt === null) {
            firstAt = Date.now();
            out.firstTokenMs = firstAt - t0;
            clearTimeout(first);
          }
          out.tokens++;
          text += delta;
          onToken?.(delta);
          // Early abort: if the measured speed cannot finish before the deadline, stop now
          // and let the template take over instead of burning the whole budget.
          if (c.earlyAbort && out.tokens >= 8) {
            const elapsed = Math.max(1, Date.now() - firstAt);
            const rate = out.tokens / elapsed; // tokens per ms
            const remaining = Math.max(0, Math.round(c.maxTokens * 0.75) - out.tokens);
            if (Date.now() + remaining / rate > deadline) {
              abort('too_slow');
              break outer;
            }
          }
        }
      }
    } catch (e) {
      if (!abortReason) {
        this.lastError = e.cause?.code ?? e.message;
        return { ...out, reason: `error:${this.lastError}`, text, ms: Date.now() - t0 };
      }
    } finally {
      clearTimeout(hard);
      clearTimeout(first);
    }
    out.ms = Date.now() - t0;
    if (abortReason) {
      try {
        ctrl.abort();
      } catch {}
      return { ...out, reason: abortReason, text };
    }
    const v = vetOutput(text, prompt, { finishedByLength: finish === 'length' });
    if (!v.ok) return { ...out, reason: `guard:${v.reason}`, text };
    this.lastOk = Date.now();
    this.lastError = null;
    return { ...out, ok: true, text: v.text, model };
  }
}
