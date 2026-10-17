// 只读补查（测试网/本机重演；假事件模式不跑）：
// 1) 提案不是从本页送出时（例如 driver CLI），proposal_seen 不带交易哈希，就用 eth_getLogs 按 id 找 Proposed 事件补上；
// 2) 合约地址向 Sourcify 查验，画面才显示「已验证」徽章（查不到或网络失败就不显示，不下结论）。
// 全部是 GET / eth_getLogs，不签名、不广播。
import { keccak256, numberToHex, pad, toHex } from 'viem'
import { rpc } from './chain'
import { CHAIN } from './runtime'
import { store } from './store'

const PROPOSED_TOPIC = keccak256(toHex('Proposed(uint256,uint8,address,uint256,bytes,bytes32,uint64)'))

const txTried = new Map<string, number>() // id -> 已试次数
const txBusy = new Set<string>()

/** 每次重画前呼叫；对缺 proposeTx 的提案补查（每个提案最多 3 次，轮换 HTTP 端点） */
export function fillProposeTx() {
  const ga = store.deploy?.guardedAdmin
  if (!ga || CHAIN.http.length === 0) return
  for (const p of store.proposals.values()) {
    if (p.proposeTx || !p.proposeBlock || txBusy.has(p.id)) continue
    const n = txTried.get(p.id) ?? 0
    if (n >= 3) continue
    txTried.set(p.id, n + 1)
    txBusy.add(p.id)
    const url = CHAIN.http[n % CHAIN.http.length]
    const blk = numberToHex(p.proposeBlock)
    rpc<{ transactionHash?: string }[]>(url, 'eth_getLogs', [
      { address: ga, fromBlock: blk, toBlock: blk, topics: [PROPOSED_TOPIC, pad(numberToHex(BigInt(p.id)), { size: 32 })] },
    ])
      .then((logs) => {
        const h = logs?.[0]?.transactionHash
        if (h && !p.proposeTx) {
          p.proposeTx = h
          store.emit()
        }
      })
      .catch(() => {
        /* 下次重画再换下一个端点 */
      })
      .finally(() => {
        // 失败后隔 2 秒才允许重试，避免每帧都打
        setTimeout(() => txBusy.delete(p.id), 2000)
      })
  }
}

/** Sourcify 查验（每个地址只查一次；网络失败 15 秒后可重查） */
export function checkVerified(addr: string | undefined | null) {
  if (!addr || !CHAIN.sourcifyApi) return
  const key = addr.toLowerCase()
  if (store.verified.has(key)) return // err 状态由下面的计时器清掉后才重查
  store.verified.set(key, 'pending')
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 8000)
  fetch(CHAIN.sourcifyApi + addr, { signal: ctl.signal })
    .then(async (r) => {
      if (r.status === 404) return store.verified.set(key, 'no')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as { match?: string | null; runtimeMatch?: string | null }
      store.verified.set(key, j.match || j.runtimeMatch ? 'yes' : 'no')
    })
    .catch(() => {
      store.verified.set(key, 'err')
      setTimeout(() => {
        if (store.verified.get(key) === 'err') store.verified.delete(key)
      }, 15000)
    })
    .finally(() => {
      clearTimeout(t)
      store.emit()
    })
}
