// 把 ?mode=chain（云端只读版）要用的公开链上资料从 shared/ 抄进 src/chain-data.json，
// 让 bundle 自带部署地址、GuardedAdmin ABI 与规则哈希表（Vite dev 不允许读 web/ 以外的档案）。
// 只抄公开资料：地址、ABI 的 event 与 view 函数、规则 id/哈希/中文说明。
//   node scripts/sync-chain-data.mjs        （npm run build:cloud 会先跑）
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shared = join(here, '..', '..', 'shared')
const read = (p) => JSON.parse(readFileSync(join(shared, p), 'utf8'))

const dep = read('deployments/10143.json')
const abiRaw = read('abi/GuardedAdmin.json')
const abiAll = Array.isArray(abiRaw) ? abiRaw : abiRaw.abi
const wantEvents = new Set(['Proposed', 'Vetoed', 'Executed', 'ReasonAttached'])
const wantFns = new Set(['getProposal', 'nextId', 'delayBlocks'])
const abi = abiAll.filter((x) => (x.type === 'event' && wantEvents.has(x.name)) || (x.type === 'function' && wantFns.has(x.name)))
const rules = read('rules.json').rules.map((r) => ({ rule: r.rule, ruleHash: r.ruleHash, zh: r.zh }))

const out = {
  chainId: dep.chainId,
  guardedAdmin: dep.guardedAdmin,
  proxy: dep.proxy,
  delayBlocks: dep.delayBlocks,
  deployBlock: dep.deployBlock,
  guardians: dep.guardians,
  impls: dep.impls,
  abi,
  rules,
}
const dst = join(here, '..', 'src', 'chain-data.json')
writeFileSync(dst, JSON.stringify(out, null, 2) + '\n')
console.log(`chain-data.json: ${abi.length} ABI 项、${rules.length} 条规则、${dep.guardians.length} 个 guardian`)
