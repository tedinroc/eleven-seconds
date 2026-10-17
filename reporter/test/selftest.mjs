#!/usr/bin/env node
// Self-test for the reporter with fake sim_result events. No chain, no real LM Studio.
// Spins up fake sentinels (SSE + /attach) and fake LM Studio servers on ephemeral ports,
// runs the reporter in-process against them, and checks:
//   templates for every rule, output guards, dedupe across 3 sentinels, hash recompute
//   from reports/<id>.json, attach payload, LLM streaming path (prefill), timeout and
//   slow-model fallback to the template (cached: true), sentinel-1 down.
//   node test/selftest.mjs          (exit code 0 = all passed)
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { keccak256, stringToBytes, toFunctionSelector } from 'viem';
import { startReporter, configFromEnv } from '../src/reporter.mjs';
import { buildFacts } from '../src/facts.mjs';
import { templateReport } from '../src/templates.mjs';
import { buildPrompt, vetOutput } from '../src/llm.mjs';
import { RULE_IDS, ruleHashOf, loadRules } from '../src/rules.mjs';
import { subscribeSse } from '../src/sse.mjs';

const results = [];
const ONLY = process.env.SELFTEST_ONLY ?? '';
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push([true, name]);
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ---- fake sim_result events in the sentinel's format -------------------------------
const SUPPLY = 21_000_000n * 10n ** 8n;
const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const IMPL = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const X = 10n ** 8n;
const okc = (name, before, after = before) => ({ name, before, after, ok: true });
const bad = (name, before, after) => ({ name, before, after, ok: false });
const baseChecks = () => [
  okc('R1_TOTAL_SUPPLY', SUPPLY.toString()),
  okc('R2_OWNER', OWNER),
  okc('R3_TRANSFER_CONSERVATION', `receiver+${X}`),
  okc('R4_TRANSFER_LIVENESS', 'transfer', 'success'),
];
function simFor(rule, id = 7) {
  const checks = baseChecks();
  const extra = { selectorsRemoved: [], culprits: [], skimmedTo: [], probes: 24, truncated: false, calls: 40 };
  let selectorsAdded = [];
  if (rule === 'R1_TOTAL_SUPPLY') {
    checks[0] = bad('R1_TOTAL_SUPPLY', SUPPLY.toString(), (SUPPLY + 2n ** 200n).toString());
    extra.culprits = [{ selector: toFunctionSelector('mint(address,uint256)'), args: [], effects: ['supply'] }];
  }
  if (rule === 'R2_OWNER') {
    checks[1] = bad('R2_OWNER', OWNER, '0x' + 'a1'.repeat(20));
    selectorsAdded = [toFunctionSelector('claimOwner()')];
    extra.culprits = [{ selector: selectorsAdded[0], args: [], effects: ['owner'] }];
  }
  if (rule === 'R3_TRANSFER_CONSERVATION') {
    checks[2] = bad('R3_TRANSFER_CONSERVATION', `receiver+${X}`, `receiver+${(X * 9n) / 10n}`);
    extra.skimmedTo = [{ address: OWNER, delta: (X / 10n).toString() }];
  }
  if (rule === 'R4_TRANSFER_LIVENESS') checks[3] = bad('R4_TRANSFER_LIVENESS', 'transfer', 'reverted');
  if (rule === 'R6_SIM_FAILURE') extra.error = 'both simulate RPCs timed out (2500 ms each)';
  if (rule === 'R7_CONFIG_GUARD') checks.splice(0, 4, bad('R7_CONFIG_GUARD', 'guardian enabled', 'remove (not approved)'));
  if (rule === 'pass') selectorsAdded = [toFunctionSelector('version()')];
  const veto = rule !== 'pass';
  return {
    v: 1,
    type: 'sim_result',
    ts: Date.now(),
    mode: 'replay',
    source: 'sentinel-1',
    id,
    verdict: veto ? 'veto' : 'pass',
    rule: veto ? rule : null,
    ruleHash: veto && RULE_IDS.includes(rule) ? ruleHashOf(rule) : null,
    checks,
    selectorsAdded,
    simMs: 412,
    extra,
  };
}
function seenFor(id, kind = 0, target = IMPL, proposeBlock = 1000) {
  return {
    v: 1, type: 'proposal_seen', ts: Date.now(), mode: 'replay', source: 'sentinel-1',
    id, kind, target, codehash: keccak256(stringToBytes(target)), proposeBlock, readyBlock: proposeBlock + 30, path: 'ws',
  };
}

// ---- fake sentinels: SSE + /attach ---------------------------------------------------
async function fakeSentinels(n = 3, { attach = true } = {}) {
  const attached = [];
  const servers = [];
  for (let i = 1; i <= n; i++) {
    const clients = new Set();
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': hello\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && req.url === '/attach' && i === 1 && attach) {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => {
          attached.push(JSON.parse(b));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, txHash: '0x' + 'ab'.repeat(32) }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    const port = await listen(srv);
    servers.push({ srv, port, clients, source: `sentinel-${i}` });
  }
  const emit = (k, ev) => {
    const s = servers[k];
    const line = `data: ${JSON.stringify({ ...ev, source: s.source, ts: Date.now() })}\n\n`;
    for (const c of s.clients) c.write(line);
  };
  const waitClients = async () => {
    for (let i = 0; i < 100 && servers.some((s) => s.clients.size === 0); i++) await sleep(20);
  };
  return {
    servers,
    attached,
    emit,
    emitAll: (ev) => servers.forEach((_, k) => emit(k, ev)),
    waitClients,
    urls: servers.map((s) => `http://127.0.0.1:${s.port}/events?backlog=50`),
    attachUrl: `http://127.0.0.1:${servers[0].port}/attach`,
    close: () => servers.forEach((s) => (s.clients.forEach((c) => c.end()), s.srv.closeAllConnections(), s.srv.close())),
  };
}

// ---- fake LM Studio --------------------------------------------------------------------
async function fakeLm({ text = '', tokenMs = 10, firstDelayMs = 0, hang = false } = {}) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b-variant' }, { id: 'qwen3.8-27b' }] }));
    }
    if (req.url === '/v1/completions') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', async () => {
        const body = JSON.parse(b);
        requests.push(body);
        if (body.max_tokens === 1) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ text: '你' }] }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let closed = false;
        res.on('close', () => (closed = true)); // (req 'close' fires right after the body is read)
        if (hang) return; // never send anything
        await sleep(firstDelayMs);
        for (const ch of Array.from(text)) {
          if (closed) return;
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, text: ch, finish_reason: null }] })}\n\n`);
          await sleep(tokenMs);
        }
        if (closed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, text: '', finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(srv);
  return { url: `http://127.0.0.1:${port}`, requests, close: () => (srv.closeAllConnections(), srv.close()) };
}

async function withReporter(over, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'reporter-selftest-'));
  const cfg = configFromEnv({
    REPORTER_PORT: '0',
    REPORTS_DIR: dir,
    LLM_URL: 'http://127.0.0.1:9', // closed port -> template
    LLM_WARMUP: '0',
    AGG_MS: '150',
    TEMPLATE_CHUNK_MS: '1',
    ATTACH_TIMEOUT_MS: '1500',
    ...over.env,
  });
  cfg.sentinels = over.sentinels;
  cfg.attachUrl = over.attachUrl;
  const logs = [];
  const r = await startReporter(cfg, { log: (m) => logs.push(m) });
  const events = [];
  const sub = subscribeSse(`http://127.0.0.1:${r.port}/events`, (ev) => events.push(ev), { log: () => {} });
  for (let i = 0; i < 100 && !sub.status.connected; i++) await sleep(10);
  try {
    await fn({ r, events, dir, logs });
  } finally {
    sub.stop();
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function checkRecord(rec, dir, events) {
  // report_done may still be in flight on the SSE socket when the record resolves
  for (let i = 0; i < 50 && !events.some((e) => e.type === 'report_done' && String(e.id) === rec.id); i++) await sleep(10);
  assert.equal(rec.hash, keccak256(stringToBytes(rec.text)), 'hash = keccak256(utf8 text)');
  const onDisk = JSON.parse(readFileSync(path.join(dir, `${rec.id}.json`), 'utf8'));
  assert.equal(onDisk.text, rec.text);
  assert.equal(keccak256(stringToBytes(onDisk.text)), onDisk.hash, 'hash recomputes from reports/<id>.json');
  const done = events.filter((e) => e.type === 'report_done' && String(e.id) === rec.id);
  if (process.env.SELFTEST_DEBUG) console.log(events.map((e) => `${e.type}:${e.id}`).join(' '));
  assert.equal(done.length, 1, 'exactly one report_done');
  assert.equal(done[0].hash, rec.hash);
  assert.equal(done[0].source, 'reporter');
  assert.equal(done[0].v, 1);
  for (const k of ['ts', 'mode', 'text', 'cached']) assert.ok(k in done[0], `report_done has ${k}`);
  return { onDisk, done: done[0] };
}

// ---- tests -------------------------------------------------------------------------------
await test('templates: every rule renders clean Simplified Chinese', () => {
  for (const rule of [...RULE_IDS, 'pass', 'R9_SOMETHING_NEW']) {
    const kind = rule === 'R7_CONFIG_GUARD' ? 1 : 0;
    const f = buildFacts(simFor(rule), seenFor(7, kind), { decimals: 8, symbol: 'dBTC' });
    const t = templateReport(f);
    console.log(`     [${rule}] ${t}`);
    assert.ok(t.length >= 40 && t.length <= 300, `length ${t.length}`);
    assert.ok(/[一-鿿]/.test(t));
    assert.ok(t.endsWith('。'));
    assert.doesNotMatch(t, /undefined|NaN|null|\[object|绝对安全/);
    if (rule === 'R1_TOTAL_SUPPLY') assert.match(t, /21,000,000 dBTC/);
    if (rule === 'R3_TRANSFER_CONSERVATION') assert.match(t, /实际到账 0\.9 dBTC/);
    if (rule === 'R3_TRANSFER_CONSERVATION') assert.match(t, /-10\.00%/);
    if (rule === 'pass') assert.match(t, /放行/);
  }
});

await test('rules: shared/rules.json (if present) agrees with keccak256("GUARD/<id>")', () => {
  const r = loadRules(new URL('../../shared/rules.json', import.meta.url).pathname);
  for (const id of RULE_IDS) assert.equal(r.byId.get(id), ruleHashOf(id), id);
});

await test('prompt: facts only, no bytecode, empty think block prefill', () => {
  const p = buildPrompt(buildFacts(simFor('R3_TRANSFER_CONSERVATION'), seenFor(7), { decimals: 8, symbol: 'dBTC' }));
  assert.ok(p.raw.endsWith('<|im_start|>assistant\n<think>\n\n</think>\n\n'));
  assert.match(p.user, /R3_TRANSFER_CONSERVATION/);
  assert.match(p.user, /冷静期：30 个区块/);
  assert.doesNotMatch(p.user, /0x60806040|0x6080/);
});

await test('guards: banned phrase, identity speculation, invented numbers are rejected', () => {
  const p = buildPrompt(buildFacts(simFor('R1_TOTAL_SUPPLY'), seenFor(7), { decimals: 8, symbol: 'dBTC' }));
  assert.equal(vetOutput('该升级绝对安全，可以放心执行，建议多签尽快签署通过。', p).ok, false);
  assert.equal(vetOutput('攻击者可能是内部员工，建议多签维持否决并轮换密钥。', p).ok, false);
  assert.equal(vetOutput('新实现让总供应量增加了 5,000,000 dBTC，建议多签维持否决。', p).ok, false);
  const good = vetOutput('陌生地址调用 mint 后总供应量凭空增加，说明任何人都能增发。建议多签维持否决并轮换 owner 密钥。', p);
  assert.equal(good.ok, true, good.reason);
});

await test('e2e template path: 3 sentinels -> one report, hash on disk, attach via sentinel-1', async () => {
  const s = await fakeSentinels(3);
  try {
    await withReporter({ sentinels: s.urls, attachUrl: s.attachUrl, env: {} }, async ({ r, events, dir }) => {
      await s.waitClients();
      const wait = r.waitForReport((x) => x.id === '7', 5000);
      s.emitAll(seenFor(7));
      s.emitAll(simFor('R3_TRANSFER_CONSERVATION'));
      const t0 = Date.now();
      const rec = await wait;
      assert.ok(Date.now() - t0 < 3000, 'template report is fast');
      const { done } = await checkRecord(rec, dir, events);
      assert.equal(done.cached, true);
      assert.equal(rec.rule, 'R3_TRANSFER_CONSERVATION');
      const toks = events.filter((e) => e.type === 'report_token' && String(e.id) === '7');
      assert.equal(toks.map((e) => e.delta).join(''), rec.text, 'report_token deltas rebuild the text');
      assert.ok(toks.every((e) => e.cached === true));
      assert.deepEqual(s.attached, [{ id: 7, reportHash: rec.hash }]);
      assert.equal(rec.attach.ok, true);
      // replays and duplicates from any sentinel must not produce a second report
      s.emitAll(simFor('R3_TRANSFER_CONSERVATION'));
      await sleep(400);
      assert.equal(events.filter((e) => e.type === 'report_done').length, 1);
      assert.equal(s.attached.length, 1);
    });
  } finally {
    s.close();
  }
});

await test('e2e pass verdict gets a "why it passed" report', async () => {
  const s = await fakeSentinels(1);
  try {
    await withReporter({ sentinels: s.urls, attachUrl: s.attachUrl, env: {} }, async ({ r, events, dir }) => {
      await s.waitClients();
      const wait = r.waitForReport((x) => x.id === '8', 5000);
      s.emitAll(seenFor(8));
      s.emitAll(simFor('pass', 8));
      const rec = await wait;
      await checkRecord(rec, dir, events);
      assert.equal(rec.verdict, 'pass');
      assert.match(rec.text, /放行/);
      assert.match(rec.text, /0x54fd4d50/); // version()
    });
  } finally {
    s.close();
  }
});

await test('e2e LLM path: streams tokens from LM Studio /v1/completions', async () => {
  const s = await fakeSentinels(1);
  const reply = '陌生地址调用 0x40c10f19 后总供应量凭空增加，说明任何人都能增发 dBTC。建议多签维持否决，不要执行，并轮换 owner 密钥。';
  const lm = await fakeLm({ text: reply, tokenMs: 5 });
  try {
    await withReporter({ sentinels: s.urls, attachUrl: s.attachUrl, env: { LLM_URL: lm.url } }, async ({ r, events, dir }) => {
      await s.waitClients();
      const wait = r.waitForReport((x) => x.id === '9', 8000);
      s.emitAll(seenFor(9));
      s.emitAll(simFor('R1_TOTAL_SUPPLY', 9));
      const rec = await wait;
      const { done } = await checkRecord(rec, dir, events);
      assert.equal(done.cached, false);
      assert.equal(rec.text, reply);
      assert.equal(rec.model, 'qwen3.8-27b', 'picks the Qwen3.8 model');
      const req = lm.requests.find((x) => x.max_tokens !== 1);
      assert.ok(req.prompt.endsWith('<think>\n\n</think>\n\n'), 'empty think block prefill');
      assert.ok(req.max_tokens <= 80);
      assert.equal(req.stream, true);
      const toks = events.filter((e) => e.type === 'report_token' && String(e.id) === '9');
      assert.equal(toks.map((e) => e.delta).join(''), reply);
      assert.equal(s.attached[0].reportHash, rec.hash);
    });
  } finally {
    s.close();
    lm.close();
  }
});

await test('e2e slow model: falls back to template within the budget, UI told to restart', async () => {
  const s = await fakeSentinels(1);
  const lm = await fakeLm({ text: '陌生地址调用后总供应量增加了很多很多很多，很危险很危险很危险很危险很危险很危险。', tokenMs: 400 });
  try {
    await withReporter(
      { sentinels: s.urls, attachUrl: s.attachUrl, env: { LLM_URL: lm.url, LLM_TIMEOUT_MS: '3000', LLM_MIN_BUDGET_MS: '500' } },
      async ({ r, events, dir }) => {
        await s.waitClients();
        const wait = r.waitForReport((x) => x.id === '10', 8000);
        s.emitAll(seenFor(10));
        const t0 = Date.now();
        s.emitAll(simFor('R1_TOTAL_SUPPLY', 10));
        const rec = await wait;
        assert.ok(Date.now() - t0 < 3600, `within budget (${Date.now() - t0} ms)`);
        const { done } = await checkRecord(rec, dir, events);
        assert.equal(done.cached, true);
        assert.match(rec.fallbackReason, /too_slow|timeout/);
        const restart = events.find((e) => e.type === 'report_token' && e.cached === true && e.extra?.restart);
        assert.ok(restart, 'first template token carries extra.restart');
      },
    );
  } finally {
    s.close();
    lm.close();
  }
});

await test('e2e 1.7 tok/s model with the real 20 s budget: early abort, template in a few seconds', async () => {
  const s = await fakeSentinels(1);
  const lm = await fakeLm({ text: '陌生地址调用后总供应量凭空增加了，这说明任何人都能增发，建议多签维持否决并轮换密钥。', tokenMs: 600 });
  try {
    await withReporter({ sentinels: s.urls, attachUrl: s.attachUrl, env: { LLM_URL: lm.url } }, async ({ r, events, dir }) => {
      await s.waitClients();
      const wait = r.waitForReport((x) => x.id === '14', 15000);
      const t0 = Date.now();
      s.emitAll(simFor('R1_TOTAL_SUPPLY', 14));
      const rec = await wait;
      const ms = Date.now() - t0;
      assert.ok(ms < 7000, `early abort (${ms} ms)`);
      assert.equal((await checkRecord(rec, dir, events)).done.cached, true);
      assert.equal(rec.fallbackReason, 'too_slow');
    });
  } finally {
    s.close();
    lm.close();
  }
});

await test('e2e hung model: first-token timeout -> template', async () => {
  const s = await fakeSentinels(1);
  const lm = await fakeLm({ hang: true });
  try {
    await withReporter(
      { sentinels: s.urls, attachUrl: s.attachUrl, env: { LLM_URL: lm.url, LLM_TIMEOUT_MS: '20000', LLM_FIRST_TOKEN_MS: '1500' } },
      async ({ r, events, dir }) => {
        await s.waitClients();
        const wait = r.waitForReport((x) => x.id === '11', 8000);
        s.emitAll(simFor('R2_OWNER', 11));
        const t0 = Date.now();
        const rec = await wait;
        assert.ok(Date.now() - t0 < 2500);
        assert.equal((await checkRecord(rec, dir, events)).done.cached, true);
        assert.equal(rec.fallbackReason, 'first_token_timeout');
      },
    );
  } finally {
    s.close();
    lm.close();
  }
});

await test('e2e model says something banned -> template', async () => {
  const s = await fakeSentinels(1);
  const lm = await fakeLm({ text: '这次升级绝对安全，建议多签直接执行，无需担心任何问题。', tokenMs: 2 });
  try {
    await withReporter({ sentinels: s.urls, attachUrl: s.attachUrl, env: { LLM_URL: lm.url } }, async ({ r, events, dir }) => {
      await s.waitClients();
      const wait = r.waitForReport((x) => x.id === '12', 8000);
      s.emitAll(simFor('pass', 12));
      const rec = await wait;
      assert.equal((await checkRecord(rec, dir, events)).done.cached, true);
      assert.match(rec.fallbackReason, /guard:banned_phrase/);
      assert.doesNotMatch(rec.text, /绝对安全/);
    });
  } finally {
    s.close();
    lm.close();
  }
});

await test('e2e sentinel-1 down: report still produced, attach only logged, no hang', async () => {
  const s = await fakeSentinels(1, { attach: false });
  try {
    await withReporter(
      { sentinels: [...s.urls, 'http://127.0.0.1:9/events'], attachUrl: 'http://127.0.0.1:9/attach', env: {} },
      async ({ r, events, dir, logs }) => {
        await s.waitClients();
        const wait = r.waitForReport((x) => x.id === '13', 5000);
        s.emitAll(simFor('R6_SIM_FAILURE', 13));
        const t0 = Date.now();
        const rec = await wait;
        assert.ok(Date.now() - t0 < 2000);
        await checkRecord(rec, dir, events);
        assert.equal(rec.attach.ok, false);
        assert.ok(logs.some((l) => /attach skipped/.test(l)));
      },
    );
  } finally {
    s.close();
  }
});

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
