#!/usr/bin/env node
// One-shot check of the real LM Studio path (no sentinels, no files, no attach):
// builds the prompt for a fake EvilFee (R3) sim_result, streams the answer, and prints
// time-to-first-token, tokens/s and whether the output passes the report guards.
//   node tools/probe-llm.mjs            (LLM_URL / LLM_MODEL / LLM_TIMEOUT_MS env apply)
//   node tools/probe-llm.mjs R1_TOTAL_SUPPLY
import { buildFacts } from '../src/facts.mjs';
import { buildPrompt, LmStudio } from '../src/llm.mjs';
import { templateReport } from '../src/templates.mjs';
import { configFromEnv } from '../src/reporter.mjs';

const rule = process.argv[2] ?? 'R3_TRANSFER_CONSERVATION';
const X = 10n ** 8n;
const SUPPLY = 21_000_000n * X;
const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const checks = [
  { name: 'R1_TOTAL_SUPPLY', before: SUPPLY.toString(), after: SUPPLY.toString(), ok: true },
  { name: 'R2_OWNER', before: OWNER, after: OWNER, ok: true },
  { name: 'R3_TRANSFER_CONSERVATION', before: `receiver+${X}`, after: `receiver+${X}`, ok: true },
  { name: 'R4_TRANSFER_LIVENESS', before: 'transfer', after: 'success', ok: true },
];
const extra = {};
if (rule.startsWith('R1')) checks[0] = { ...checks[0], after: (SUPPLY * 1000n).toString(), ok: false };
if (rule.startsWith('R3')) {
  checks[2] = { ...checks[2], after: `receiver+${(X * 9n) / 10n}`, ok: false };
  extra.skimmedTo = [{ address: OWNER, delta: (X / 10n).toString() }];
}
const sim = { id: 1, verdict: rule === 'pass' ? 'pass' : 'veto', rule: rule === 'pass' ? null : rule, checks, selectorsAdded: [], simMs: 400, extra };
const seen = { id: 1, kind: 0, target: '0x5fbdb2315678afecb367f032d93f642f64180aa3', proposeBlock: 100, readyBlock: 130 };

const cfg = configFromEnv();
const facts = buildFacts(sim, seen, { decimals: cfg.decimals, symbol: cfg.symbol });
const prompt = buildPrompt(facts);
const llm = new LmStudio(cfg.llm);
console.log(`LM Studio ${cfg.llm.baseUrl} api=${cfg.llm.api} max_tokens=${cfg.llm.maxTokens} budget=${cfg.llm.timeoutMs} ms`);
console.log('--- facts ---\n' + facts.lines.join('\n') + '\n--- stream ---');
const t0 = Date.now();
const r = await llm.generate(prompt, { deadline: t0 + cfg.llm.timeoutMs, onToken: (d) => process.stdout.write(d) });
const ms = Date.now() - t0;
const tps = r.tokens && r.firstTokenMs !== null ? (r.tokens / Math.max(0.001, (ms - r.firstTokenMs) / 1000)).toFixed(1) : '-';
console.log(`\n--- result ---\nok=${r.ok} reason=${r.reason ?? '-'} model=${r.model ?? llm.model ?? '-'} tokens=${r.tokens} ttft=${r.firstTokenMs ?? '-'} ms total=${ms} ms ≈${tps} tok/s`);
if (!r.ok) console.log(`template fallback would be:\n${templateReport(facts)}`);
process.exit(0);
