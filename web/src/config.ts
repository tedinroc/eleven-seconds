// 战情室前端的全部设定集中在这一个文件。
// 注意：本文件也会被 vite.config.ts 在 Node 端读取（用来建代理），所以这里只能放纯数据，
// 不能用 import.meta.env、window 或任何浏览器 API。
//
// 运行期覆盖（URL 参数，方便现场切换，不必重新 build）：
//   ?mode=testnet | replay | fake | chain   模式（默认见 defaultMode；云端版 vite build --mode cloud 默认 chain）
//     chain：浏览器直连 Monad 测试网唯读（不连 driver/哨兵/reporter），见 chainwatch.ts
//   ?anvil=8548                       本机重演模式连哪个 anvil 端口（默认 8545）

export type AppMode = 'testnet' | 'replay' | 'fake' | 'chain'

export interface ChainConfig {
  chainId: number
  /** 顶部徽章文字 */
  badge: string
  /** WebSocket 端点，依序尝试；断线就轮换下一个，同时退回 HTTP 轮询 */
  ws: string[]
  /** 断线时 300ms 轮询 eth_blockNumber 用的 HTTP 端点（不用模拟专用的两家，见 spec 4.2.3） */
  http: string[]
  /** eth_subscribe 的订阅名：测试网 monadNewHeads（带 commitState），anvil 只有 newHeads */
  headsMethod: 'monadNewHeads' | 'newHeads'
  /** 交易浏览器前缀；本机没有 */
  explorerTx: string | null
  /** 地址浏览器前缀；本机没有 */
  explorerAddr: string | null
  /** Sourcify 查验 API 前缀（GET <prefix><address> → { match }）；本机没有 */
  sourcifyApi: string | null
}

export type ServiceName = 'sentinel-1' | 'sentinel-2' | 'sentinel-3' | 'driver' | 'reporter'

export const CONFIG = {
  defaultMode: 'replay' as AppMode,

  chains: {
    testnet: {
      chainId: 10143,
      badge: 'Monad 测试网 10143',
      ws: ['wss://testnet-rpc.monad.xyz', 'wss://rpc-testnet.monadinfra.com'],
      // ankr 放第一：读取顺序依 2026-10-17 会场网路实测排序（两家都在 spec 4.2.3 的 getLogs/心跳名单内）
      http: ['https://rpc.ankr.com/monad_testnet', 'https://rpc-testnet.monadinfra.com'],
      headsMethod: 'monadNewHeads',
      explorerTx: 'https://testnet.monadexplorer.com/tx/',
      explorerAddr: 'https://testnet.monadexplorer.com/address/',
      // Monad 测试网的 Sourcify 实例（部署脚本的 VERIFIER_URL 同一家）；浏览器端只读 GET，允许 CORS
      sourcifyApi: 'https://sourcify-api-monad.blockvision.org/v2/contract/10143/',
    } satisfies ChainConfig,
    /** 云端只读版：浏览器直连测试网（两家 HTTP 端点都已确认允许 CORS） */
    chain: {
      chainId: 10143,
      badge: 'Monad 测试网 · 链上只读',
      ws: ['wss://testnet-rpc.monad.xyz'],
      http: ['https://testnet-rpc.monad.xyz', 'https://rpc.ankr.com/monad_testnet'],
      headsMethod: 'monadNewHeads',
      // monadexplorer.com 会 308 转到 monadvision，这里直接用新网域
      explorerTx: 'https://testnet.monadvision.com/tx/',
      explorerAddr: 'https://testnet.monadvision.com/address/',
      sourcifyApi: 'https://sourcify-api-monad.blockvision.org/v2/contract/10143/',
    } satisfies ChainConfig,
    replay: {
      chainId: 31337,
      badge: '本机重演',
      ws: ['ws://127.0.0.1:{anvil}'],
      http: ['http://127.0.0.1:{anvil}'],
      headsMethod: 'newHeads',
      explorerTx: null,
      explorerAddr: null,
      sourcifyApi: null,
    } satisfies ChainConfig,
  },
  defaultAnvilPort: 8545,

  /** 本机服务（spec 第 5 节端口表） */
  services: {
    'sentinel-1': 'http://127.0.0.1:8701',
    'sentinel-2': 'http://127.0.0.1:8702',
    'sentinel-3': 'http://127.0.0.1:8703',
    driver: 'http://127.0.0.1:8700',
    reporter: 'http://127.0.0.1:8710',
  } satisfies Record<ServiceName, string>,
  /** true：浏览器走 Vite dev/preview 的同源代理 /svc/<name>/…（免 CORS）；false：直连 services */
  viaProxy: true,
  ssePath: '/events',

  /** 前端判定离线：这么久没收到某来源的任何事件（含 heartbeat） */
  heartbeatTimeoutMs: 2000,
  /** WS 断线时轮询 eth_blockNumber 的间隔 */
  pollMs: 300,
  /** 实测出块时间的滑动窗口（块数） */
  blockTimeWindow: 60,

  /** MON 美元汇率：由操作者手动填写；rate 为 null 时画面只显示 MON。测试网 MON 没有市价，填的是参考值。 */
  monUsd: { rate: null as number | null, date: '' },

  /** S5 对照表的参考出块时间（外链数据，非本系统实测）；Monad 一行永远显示实测值 */
  referenceChains: [
    // id 对应 i18n 的 ref.<id>（链名）；note 为 zh-CN 原文，其他语言由 blockSec 套模板
    { id: 'eth', name: '以太坊', blockSec: 12, note: '约 12 秒/块' },
    { id: 'bsc', name: 'BSC', blockSec: 0.45, note: '约 0.45 秒/块' },
  ],
  /** 只在 driver /deployments 拿不到时才用；画面优先用部署档里的 delayBlocks */
  delayBlocks: 30,
  /** AI 报告完成后几毫秒自动收起（R 键可再打开） */
  reportAutoCloseMs: 8000,
  /** 出块时间低于这个值视为 anvil 快进挖块，不当成实测秒/块 */
  minPlausibleBlockMs: 50,
}
