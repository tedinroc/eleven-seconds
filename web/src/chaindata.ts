// chain / arena 两种读链模式用的公开链上资料（部署地址、GuardedAdmin ABI 片段、规则哈希表）。
//  - chain：src/chain-data.json（scripts/sync-chain-data.mjs 由 shared/deployments/10143.json 产生）
//  - arena：src/chain-data-arena.json（scripts/sync-arena-data.mjs 由 shared/deployments/10143-arena.json 产生）
// 两份格式相同；arena 部署档还没产生时是占位档（pending: true），画面会标示「合约尚未部署」。
import MAIN from './chain-data.json'
import ARENA_DATA from './chain-data-arena.json'
import { MODE } from './runtime'

export type ChainData = typeof MAIN

export const DATA: ChainData = (MODE === 'arena' ? ARENA_DATA : MAIN) as ChainData

/** arena 部署档还没产生（占位档） */
export const ARENA_PENDING = MODE === 'arena' && (ARENA_DATA as { pending?: boolean }).pending === true
