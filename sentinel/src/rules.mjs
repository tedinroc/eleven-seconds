// Rule IDs and ruleHash (spec 4.2 / 4.3): ruleHash = keccak256(utf8("GUARD/<ID>")).
// shared/rules.json (written by the contracts line) is the source of truth when present;
// we recompute every hash and refuse to start on a mismatch so the frontend, the reporter
// and the chain all agree on the same bytes32.
import { readFileSync, existsSync } from 'node:fs'
import { keccak256, stringToBytes } from 'viem'

export const RULE_IDS = [
  'R1_TOTAL_SUPPLY',
  'R2_OWNER',
  'R3_TRANSFER_CONSERVATION',
  'R4_TRANSFER_LIVENESS',
  'R5_STRICT_CODEHASH',
  'R6_SIM_FAILURE',
  'R7_CONFIG_GUARD',
  'R8_INIT_DATA',
]

export const ruleKey = (id) => `GUARD/${id}`
export const computeRuleHash = (id) => keccak256(stringToBytes(ruleKey(id)))

// Accepts the shapes we expect shared/rules.json to take:
//  { "R1_TOTAL_SUPPLY": "0x.." } | { "GUARD/R1_TOTAL_SUPPLY": "0x.." }
//  { "R1_TOTAL_SUPPLY": { "hash"|"ruleHash": "0x..", ... } }
//  { "rules": [ { "id": "R1_TOTAL_SUPPLY"|"GUARD/R1..", "hash"|"ruleHash": "0x.." } ] } | [ ...same ]
function parseRulesFile(json) {
  const out = {}
  const put = (rawId, hash) => {
    if (typeof rawId !== 'string' || typeof hash !== 'string') return
    const id = rawId.replace(/^GUARD\//, '')
    out[id] = hash.toLowerCase()
  }
  const list = Array.isArray(json) ? json : Array.isArray(json?.rules) ? json.rules : null
  if (list) {
    for (const r of list) put(r.id ?? r.rule ?? r.name ?? r.key, r.hash ?? r.ruleHash)
    return out
  }
  for (const [k, v] of Object.entries(json ?? {})) {
    if (typeof v === 'string') put(k, v)
    else if (v && typeof v === 'object') put(v.id ?? k, v.hash ?? v.ruleHash)
  }
  return out
}

export function loadRules(rulesPath, log = console) {
  const table = {}
  for (const id of RULE_IDS) table[id] = { id, key: ruleKey(id), hash: computeRuleHash(id) }
  if (rulesPath && existsSync(rulesPath)) {
    const fromFile = parseRulesFile(JSON.parse(readFileSync(rulesPath, 'utf8')))
    for (const [id, hash] of Object.entries(fromFile)) {
      if (!table[id]) continue
      if (table[id].hash !== hash) {
        throw new Error(`rules.json hash mismatch for ${id}: file ${hash} != keccak256("${ruleKey(id)}") ${table[id].hash}`)
      }
    }
    log.info?.(`rules: ${Object.keys(fromFile).length} entries from rules.json verified`)
  } else {
    log.info?.('rules: rules.json not found, using computed hashes')
  }
  return table
}
