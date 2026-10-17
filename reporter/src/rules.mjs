// Rule table shared with the sentinel and the war room.
// Source of truth is shared/rules.json (A line). When it is missing we derive the
// same table from the spec: ruleHash = keccak256(UTF-8 "GUARD/<RULE_ID>").
import { readFileSync, existsSync } from 'node:fs';
import { keccak256, stringToBytes } from 'viem';

export const RULE_IDS = [
  'R1_TOTAL_SUPPLY',
  'R2_OWNER',
  'R3_TRANSFER_CONSERVATION',
  'R4_TRANSFER_LIVENESS',
  'R5_STRICT_CODEHASH',
  'R6_SIM_FAILURE',
  'R7_CONFIG_GUARD',
  'R8_INIT_DATA',
];

export const RULE_LABELS = {
  R1_TOTAL_SUPPLY: '总供应量不变',
  R2_OWNER: 'owner 不变',
  R3_TRANSFER_CONSERVATION: '转账守恒',
  R4_TRANSFER_LIVENESS: '转账可用',
  R5_STRICT_CODEHASH: '严格模式 codehash 核准',
  R6_SIM_FAILURE: '模拟失败即否决',
  R7_CONFIG_GUARD: '配置变更需核准',
  R8_INIT_DATA: '初始化数据需核准',
  pass: '全部检查通过',
};

export const KIND_LABELS = ['升级实现', '设置守护者', '修改冷静期', '更换暂停实现'];
const KIND_NAMES = ['Upgrade', 'SetGuardian', 'SetDelay', 'SetPausedImpl'];

export function ruleHashOf(id) {
  return keccak256(stringToBytes(`GUARD/${id}`));
}

/** Build { byId, byHash } from shared/rules.json if present, else from RULE_IDS. */
export function loadRules(rulesPath) {
  const byId = new Map();
  for (const id of RULE_IDS) byId.set(id, ruleHashOf(id));
  if (rulesPath && existsSync(rulesPath)) {
    try {
      const raw = JSON.parse(readFileSync(rulesPath, 'utf8'));
      // Accept a few plausible shapes: {rules:[{id,hash}]}, [{id,ruleHash}], {"GUARD/R1_...": "0x.."}
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rules) ? raw.rules : null;
      if (list) {
        for (const r of list) {
          const id = normalizeRuleId(r.id ?? r.rule ?? r.name);
          const h = r.ruleHash ?? r.hash;
          if (id && typeof h === 'string') byId.set(id, h.toLowerCase());
        }
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          const id = normalizeRuleId(k);
          const h = typeof v === 'string' ? v : v?.ruleHash ?? v?.hash;
          if (id && typeof h === 'string') byId.set(id, h.toLowerCase());
        }
      }
    } catch (e) {
      console.warn(`[reporter] rules.json unreadable, using derived table: ${e.message}`);
    }
  }
  const byHash = new Map();
  for (const [id, h] of byId) byHash.set(h.toLowerCase(), id);
  return { byId, byHash };
}

/** "GUARD/R3_TRANSFER_CONSERVATION" | "R3" | "r3_transfer..." -> "R3_TRANSFER_CONSERVATION"; pass -> "pass". */
export function normalizeRuleId(x) {
  if (x == null) return null;
  const s = String(x).trim();
  if (!s) return null;
  if (/^(pass|none|ok)$/i.test(s)) return 'pass';
  const m = s.replace(/^GUARD\//i, '').match(/^R(\d)/i);
  if (!m) return null;
  return RULE_IDS.find((id) => id.startsWith(`R${m[1]}_`)) ?? null;
}

/** Proposal kind (number | "0" | "Upgrade") -> 0..3, or null. */
export function normalizeKind(k) {
  if (k == null) return null;
  if (typeof k === 'number' && k >= 0 && k <= 3) return k;
  const s = String(k).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 0 && n <= 3 ? n : null;
  }
  const i = KIND_NAMES.findIndex((n) => n.toLowerCase() === s.toLowerCase());
  return i >= 0 ? i : null;
}
