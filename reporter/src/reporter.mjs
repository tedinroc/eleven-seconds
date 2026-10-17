// Reporter (port 8710): subscribes to the 3 sentinels' SSE, and for each proposal's
// sim_result writes a short Simplified-Chinese risk report with the local LM Studio
// (template fallback, cached: true), hashes it, stores it, and asks sentinel-1 to
// attachReason it on-chain. The report never influences the veto decision.
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, stringToBytes } from 'viem';
import { SseHub, subscribeSse } from './sse.mjs';
import { buildFacts } from './facts.mjs';
import { templateReport } from './templates.mjs';
import { buildPrompt, LmStudio } from './llm.mjs';
import { loadRules, normalizeRuleId } from './rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTER_DIR = path.resolve(HERE, '..');
const REPO_DIR = path.resolve(REPORTER_DIR, '..');

const int = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export function configFromEnv(env = process.env) {
  return {
    host: env.REPORTER_HOST || '127.0.0.1',
    port: int(env.REPORTER_PORT, 8710),
    // ?backlog=N: sentinels replay recent events to late subscribers; dedupe + STALE_MS guard re-reports.
    sentinels: (env.SENTINEL_EVENTS || [8701, 8702, 8703].map((p) => `http://127.0.0.1:${p}/events?backlog=50`).join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    attachUrl: env.ATTACH_URL ?? 'http://127.0.0.1:8701/attach',
    attachTimeoutMs: int(env.ATTACH_TIMEOUT_MS, 4000),
    // Shared secret for sentinel-1's POST /attach (sent as x-attach-secret). Unset -> header omitted.
    attachSecret: env.ATTACH_SECRET || '',
    reportsDir: path.resolve(REPORTER_DIR, env.REPORTS_DIR || 'reports'),
    rulesPath: path.resolve(REPO_DIR, env.RULES_PATH || 'shared/rules.json'),
    aggMs: int(env.AGG_MS, 400),
    staleMs: int(env.STALE_MS, 30000),
    templateChunkMs: int(env.TEMPLATE_CHUNK_MS, 25),
    decimals: int(env.TOKEN_DECIMALS, 8), // DemoBTC.decimals() == 8
    symbol: env.TOKEN_SYMBOL || 'dBTC',
    llm: {
      enabled: !bool(env.LLM_DISABLE, false),
      baseUrl: (env.LLM_URL || 'http://localhost:1234').replace(/\/+$/, ''),
      model: env.LLM_MODEL || '',
      api: env.LLM_API === 'chat' ? 'chat' : 'completions',
      timeoutMs: int(env.LLM_TIMEOUT_MS, 20000),
      firstTokenMs: int(env.LLM_FIRST_TOKEN_MS, 12000),
      maxTokens: int(env.LLM_MAX_TOKENS, 80),
      minBudgetMs: int(env.LLM_MIN_BUDGET_MS, 4000),
      earlyAbort: bool(env.LLM_EARLY_ABORT, true),
      warmup: bool(env.LLM_WARMUP, true),
    },
  };
}

function chunksOf(text, n = 3) {
  const out = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += n) out.push(chars.slice(i, i + n).join(''));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileId = (id) => String(id).replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 80);

export async function startReporter(cfg = configFromEnv(), { log = console.log } = {}) {
  const startedAt = Date.now();
  mkdirSync(path.join(cfg.reportsDir, 'archive'), { recursive: true });
  const rules = loadRules(cfg.rulesPath);
  const hub = new SseHub();
  const llm = new LmStudio(cfg.llm, log);
  const proposals = new Map(); // key -> proposal_seen
  const jobs = new Map(); // key -> { state, results, verdict, superseded }
  const done = []; // recent report summaries for /health
  const waiters = new Set(); // test hook: resolve on report completion

  const keyOf = (ev) => `${ev.mode ?? 'na'}:${String(ev.id)}`;
  const emit = (type, mode, fields) => {
    const ev = { v: 1, type, ts: Date.now(), mode: mode ?? 'replay', source: 'reporter', ...fields };
    hub.send(ev);
    return ev;
  };

  function onEvent(ev) {
    if (!ev || typeof ev !== 'object' || ev.id === undefined || ev.id === null) return;
    if (ev.type === 'proposal_seen') {
      const key = keyOf(ev);
      const prev = proposals.get(key);
      if (prev && prev.proposeBlock != null && ev.proposeBlock != null && String(prev.proposeBlock) !== String(ev.proposeBlock)) {
        jobs.delete(key); // same id on a fresh chain (e.g. anvil restarted): treat as a new proposal
      }
      proposals.set(key, ev);
      return;
    }
    if (ev.type !== 'sim_result') return;
    if (typeof ev.ts === 'number' && ev.ts < startedAt - cfg.staleMs) return; // history replay
    const key = keyOf(ev);
    const job = jobs.get(key);
    if (!job && alreadyReported(ev)) return; // reporter restarted and the backlog replayed it
    if (!job) {
      const j = { state: 'collecting', results: [ev], verdict: null, superseded: false };
      jobs.set(key, j);
      setTimeout(() => safeRun(key, j), cfg.aggMs);
    } else if (job.state === 'collecting') {
      job.results.push(ev);
    } else if (ev.verdict === 'veto' && job.verdict === 'pass' && !job.superseded) {
      // A sentinel vetoed after we already explained a pass: the veto wins, write a new report.
      job.superseded = true;
      job.results = [ev];
      log(`[reporter] #${ev.id}: late veto from ${ev.source}, superseding the pass report`);
      safeRun(key, job);
    }
  }

  function alreadyReported(ev) {
    const f = path.join(cfg.reportsDir, `${fileId(ev.id)}.json`);
    if (!existsSync(f)) return false;
    try {
      const old = JSON.parse(readFileSync(f, 'utf8'));
      return old.mode === (ev.mode ?? 'replay') && typeof ev.ts === 'number' && Date.parse(old.createdAt) >= ev.ts;
    } catch {
      return false;
    }
  }

  // Never let one bad event take the process down (Node exits on unhandled rejections).
  function safeRun(key, job) {
    runJob(key, job).catch((e) => {
      job.state = 'done';
      log(`[reporter] #${job.results[0]?.id}: report failed: ${e.stack ?? e.message}`);
    });
  }

  async function runJob(key, job) {
    job.state = 'running';
    const vetoes = job.results.filter((r) => r.verdict === 'veto');
    const sim = vetoes[0] ?? job.results[0];
    job.verdict = sim.verdict === 'veto' ? 'veto' : 'pass';
    // A veto that only carries ruleHash: resolve the rule ID through the shared table.
    const simN = { ...sim };
    if (simN.verdict === 'veto' && !normalizeRuleId(simN.rule) && simN.ruleHash) {
      const known = rules.byHash.get(String(simN.ruleHash).toLowerCase());
      if (known) simN.rule = known;
    }
    const facts = buildFacts(simN, proposals.get(key), { decimals: cfg.decimals, symbol: cfg.symbol });
    // Prefer the hash the sentinel put on-chain; fall back to the shared table.
    if (!facts.ruleHash && facts.verdict === 'veto') facts.ruleHash = rules.byId.get(facts.ruleId) ?? null;
    const t0 = Date.now();
    const deadline = t0 + cfg.llm.timeoutMs;
    let text = null;
    let cached = true;
    let reason = 'llm_disabled';
    let model = null;
    let streamed = 0;
    let llmInfo = null;
    if (cfg.llm.enabled) {
      const prompt = buildPrompt(facts);
      const r = await llm.generate(prompt, {
        deadline,
        onToken: (delta) => {
          streamed++;
          emit('report_token', facts.mode, { id: sim.id, delta, cached: false });
        },
      });
      llmInfo = { tokens: r.tokens, firstTokenMs: r.firstTokenMs, ms: r.ms };
      if (r.ok) {
        text = r.text;
        cached = false;
        reason = null;
        model = r.model;
      } else {
        reason = r.reason;
      }
    }
    if (text === null) {
      text = templateReport(facts);
      const parts = cfg.templateChunkMs > 0 ? chunksOf(text, 3) : [text];
      for (let i = 0; i < parts.length; i++) {
        const fields = { id: sim.id, delta: parts[i], cached: true };
        // The LLM had already streamed some tokens: tell the UI to clear them first.
        if (i === 0 && streamed > 0) fields.extra = { restart: true, reason };
        emit('report_token', facts.mode, fields);
        if (cfg.templateChunkMs > 0 && i < parts.length - 1) await sleep(cfg.templateChunkMs);
      }
    }
    const hash = keccak256(stringToBytes(text));
    const record = {
      v: 1,
      id: String(sim.id),
      mode: facts.mode,
      text,
      hash,
      cached,
      verdict: facts.verdict,
      rule: facts.ruleId,
      ruleHash: facts.ruleHash,
      kind: facts.kind,
      sources: [...new Set(job.results.map((r) => r.source).filter(Boolean))],
      vetoes: vetoes.length,
      model,
      fallbackReason: cached ? reason : null,
      llm: llmInfo,
      facts: facts.lines,
      createdAt: new Date().toISOString(),
      genMs: Date.now() - t0,
      attach: null,
    };
    const file = saveReport(record);
    emit('report_done', facts.mode, {
      id: sim.id,
      text,
      hash,
      cached,
      extra: { verdict: facts.verdict, rule: facts.ruleId, model, reason: cached ? reason : null, genMs: record.genMs },
    });
    log(
      `[reporter] #${record.id} ${facts.verdict}/${facts.ruleId} ${cached ? 'TEMPLATE(' + reason + ')' : 'LLM'} ` +
        `${record.genMs}ms hash=${hash.slice(0, 12)}…`,
    );
    job.state = 'done';
    // attachReason via sentinel-1: one attempt, bounded, never blocks other reports.
    record.attach = await attach(sim.id, hash);
    saveReport(record, file);
    done.push({ id: record.id, mode: record.mode, hash, cached, rule: record.rule, attach: record.attach });
    if (done.length > 50) done.shift();
    for (const w of waiters) w(record);
  }

  function saveReport(record, file) {
    const json = JSON.stringify(record, null, 2) + '\n';
    const latest = file ?? path.join(cfg.reportsDir, `${fileId(record.id)}.json`);
    if (!file && existsSync(latest)) {
      // Keep the older report (possibly a different chain/mode) so its on-chain hash stays verifiable.
      try {
        const old = JSON.parse(readFileSync(latest, 'utf8'));
        if (old.hash !== record.hash) {
          renameSync(latest, path.join(cfg.reportsDir, 'archive', `${old.mode ?? 'na'}-${old.id}-${String(old.hash).slice(2, 10)}.json`));
        }
      } catch {}
    }
    writeFileSync(latest, json);
    return latest;
  }

  async function attach(id, reportHash) {
    if (!cfg.attachUrl) return { ok: false, skipped: true };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.attachTimeoutMs);
    try {
      const headers = { 'content-type': 'application/json' };
      if (cfg.attachSecret) headers['x-attach-secret'] = cfg.attachSecret;
      const res = await fetch(cfg.attachUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id, reportHash }),
        signal: ctrl.signal,
      });
      const body = await res.text();
      let j = null;
      try {
        j = JSON.parse(body);
      } catch {}
      const r = { ok: res.ok, status: res.status, txHash: j?.txHash ?? null, at: new Date().toISOString() };
      if (!res.ok) r.error = (j?.error ?? body).toString().slice(0, 160);
      log(`[reporter] #${id} attach -> ${res.status}${r.txHash ? ' tx ' + r.txHash : ''}${r.error ? ' ' + r.error : ''}`);
      return r;
    } catch (e) {
      const why = ctrl.signal.aborted ? 'timeout' : e.cause?.code ?? e.message;
      log(`[reporter] #${id} attach skipped: sentinel-1 not reachable (${why}); report kept locally`);
      return { ok: false, error: why, at: new Date().toISOString() };
    } finally {
      clearTimeout(t);
    }
  }

  const subs = cfg.sentinels.map((u) => subscribeSse(u, onEvent, { log }));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-allow-headers': '*' });
      return res.end();
    }
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (url.pathname === '/events') return hub.handle(req, res);
    if (url.pathname === '/health') {
      return send(200, {
        ok: true,
        uptimeMs: Date.now() - startedAt,
        llm: { enabled: cfg.llm.enabled, model: llm.model, lastOk: llm.lastOk, lastError: llm.lastError },
        sentinels: subs.map((s) => ({ ...s.status })),
        sseClients: hub.clients.size,
        recent: done.slice(-10),
      });
    }
    if (url.pathname === '/reports') {
      const ids = readdirSync(cfg.reportsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
      return send(200, { ids });
    }
    const m = url.pathname.match(/^\/reports\/([0-9A-Za-z_-]{1,80})$/);
    if (m) {
      const f = path.join(cfg.reportsDir, `${m[1]}.json`);
      if (!existsSync(f)) return send(404, { error: 'not found' });
      return send(200, JSON.parse(readFileSync(f, 'utf8')));
    }
    send(404, { error: 'not found' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  const port = server.address().port;
  log(`[reporter] listening on http://${cfg.host}:${port} (events: /events, health: /health)`);
  if (cfg.llm.enabled && cfg.llm.warmup) llm.warmup();

  return {
    port,
    hub,
    llm,
    /** Resolve with the next finished report record matching pred. */
    waitForReport(pred = () => true, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          waiters.delete(w);
          reject(new Error('timeout waiting for report'));
        }, timeoutMs);
        const w = (rec) => {
          if (!pred(rec)) return;
          clearTimeout(t);
          waiters.delete(w);
          resolve(rec);
        };
        waiters.add(w);
      });
    },
    async close() {
      subs.forEach((s) => s.stop());
      hub.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await startReporter();
  const stop = async () => {
    await r.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
