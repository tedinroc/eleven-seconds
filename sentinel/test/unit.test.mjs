// Offline unit checks: selector extraction vs compiled artifacts, rule hashes vs shared/rules.json,
// ERC-1967 slot vs the OpenZeppelin constant, gas.json parsing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../src/config.mjs'
import { extractSelectors } from '../src/bytecode.mjs'
import { loadRules, computeRuleHash, RULE_IDS } from '../src/rules.mjs'
import { IMPLEMENTATION_SLOT } from '../src/simulate.mjs'
import { readGasLimits } from '../src/vetoer.mjs'

const art = (n) => resolve(REPO_ROOT, `out/${n}.sol/${n}.json`)

test('selector scan matches solc methodIdentifiers', { skip: !existsSync(art('EvilOwnerImpl')) && 'run forge build first' }, () => {
  for (const n of ['DemoBTC', 'DemoBTCV2', 'EvilMintImpl', 'EvilOwnerImpl', 'EvilFeeImpl', 'PausedImpl']) {
    const j = JSON.parse(readFileSync(art(n), 'utf8'))
    const want = Object.values(j.methodIdentifiers).map((s) => '0x' + s).sort()
    assert.deepEqual(extractSelectors(j.deployedBytecode.object), want, n)
  }
})

test('rule hashes agree with shared/rules.json', () => {
  const table = loadRules(resolve(REPO_ROOT, 'shared/rules.json'), {})
  for (const id of RULE_IDS) assert.equal(table[id].hash, computeRuleHash(id))
})

test('implementation slot equals OZ ERC1967Utils.IMPLEMENTATION_SLOT', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Utils.sol'), 'utf8')
  const m = src.match(/IMPLEMENTATION_SLOT\s*=\s*(0x[0-9a-fA-F]{64})/)
  assert.ok(m)
  assert.equal(IMPLEMENTATION_SLOT, m[1].toLowerCase())
})

test('gas.json parsing applies headroom and falls back', () => {
  const g = readGasLimits({ veto: { gasUsed: 100, gasLimit: 110 }, attachReason: 50 }, {}, 1.25)
  assert.equal(g.veto, 138n)
  assert.equal(g.attachReason, 63n)
  assert.equal(readGasLimits(null, {}, 1).veto, 200000n)
})
