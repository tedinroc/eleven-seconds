// 把 ?mode=arena（云端互动版）要用的公开链上资料从 shared/ 抄进 src/chain-data-arena.json。
// 格式同 sync-chain-data.mjs（chain-data.json），来源改成独立的 arena 部署 shared/deployments/10143-arena.json。
// 部署档还没产生时写入占位档（pending: true，地址为空），build 照常通过、画面显示「Arena 合约尚未部署」。
//   node scripts/sync-arena-data.mjs             （npm run build:arena 会先跑）
//   node scripts/sync-arena-data.mjs --require   （部署前用：没有部署档就失败）
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shared = join(here, '..', '..', 'shared')
const read = (p) => JSON.parse(readFileSync(join(shared, p), 'utf8'))
const DEP = 'deployments/10143-arena.json'
const require = process.argv.includes('--require')

const abiRaw = read('abi/GuardedAdmin.json')
const abiAll = Array.isArray(abiRaw) ? abiRaw : abiRaw.abi
const wantEvents = new Set(['Proposed', 'Vetoed', 'Executed', 'ReasonAttached'])
const wantFns = new Set(['getProposal', 'nextId', 'delayBlocks'])
const abi = abiAll.filter((x) => (x.type === 'event' && wantEvents.has(x.name)) || (x.type === 'function' && wantFns.has(x.name)))
const rules = read('rules.json').rules.map((r) => ({ rule: r.rule, ruleHash: r.ruleHash, zh: r.zh }))

let out
if (existsSync(join(shared, DEP))) {
  const dep = read(DEP)
  const bad = ['guardedAdmin', 'proxy', 'deployBlock', 'delayBlocks'].filter((k) => dep[k] === undefined || dep[k] === null)
  if (!Array.isArray(dep.guardians) || dep.guardians.length !== 3) bad.push('guardians[3]')
  if (bad.length) {
    console.error(`${DEP} 缺栏位：${bad.join(', ')}`)
    process.exit(1)
  }
  out = {
    pending: false,
    chainId: dep.chainId,
    guardedAdmin: dep.guardedAdmin,
    proxy: dep.proxy,
    delayBlocks: dep.delayBlocks,
    deployBlock: dep.deployBlock,
    guardians: dep.guardians,
    impls: dep.impls ?? {},
    abi,
    rules,
  }
} else {
  if (require) {
    console.error(`找不到 shared/${DEP}：arena 合约部署后才能 build 上线版`)
    process.exit(1)
  }
  out = {
    pending: true,
    chainId: 10143,
    guardedAdmin: '0x0000000000000000000000000000000000000000',
    proxy: '0x0000000000000000000000000000000000000000',
    delayBlocks: 30,
    deployBlock: 0,
    guardians: ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003'],
    impls: {},
    abi,
    rules,
  }
}
const dst = join(here, '..', 'src', 'chain-data-arena.json')
writeFileSync(dst, JSON.stringify(out, null, 2) + '\n')
console.log(out.pending ? `chain-data-arena.json：占位（还没有 shared/${DEP}）` : `chain-data-arena.json：GuardedAdmin ${out.guardedAdmin}、${out.guardians.length} 个 guardian`)
