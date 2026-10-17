// Risk report for a proposal, written with the reporter's own template (reporter/src/templates.mjs,
// the "cached: true" path of the live reporter) from the reporter's pre-computed facts. The text is
// hashed exactly like the reporter does: keccak256(utf8(text)); the hash goes on chain with
// attachReason, the full text is kept by the Durable Object for /api/state.
import { keccak256, stringToBytes } from 'viem'
import { buildFacts } from '../../../reporter/src/facts.mjs'
import { templateReport } from '../../../reporter/src/templates.mjs'

export function makeReport(sim, proposal, { decimals = 8, symbol = 'dBTC' } = {}) {
  const facts = buildFacts(sim, proposal, { decimals, symbol })
  const text = templateReport(facts)
  return { text, hash: keccak256(stringToBytes(text)), template: true, rule: facts.ruleId }
}
