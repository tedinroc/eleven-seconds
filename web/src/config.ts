// 战情室前端的全部设定集中在这一个文件。
// 注意：本文件也会被 vite.config.ts 在 Node 端读取（用来建代理），所以这里只能放纯数据，
// 不能用 import.meta.env、window 或任何浏览器 API。
//
// 运行期覆盖（URL 参数，方便现场切换，不必重新 build）：
//   ?mode=testnet | replay | fake     模式（默认见 defaultMode）
//   ?anvil=8548                       本机重演模式连哪个 anvil 端口（默认 8545）

export type AppMode = 'testnet' | 'replay' | 'fake'

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
}

export type ServiceName = 'sentinel-1' | 'sentinel-2' | 'sentinel-3' | 'driver' | 'reporter'

export const CONFIG = {
  defaultMode: 'replay' as AppMode,

  chains: {
    testnet: {
      chainId: 10143,
      badge: 'Monad 测试网 10143',
      ws: ['wss://testnet-rpc.monad.xyz', 'wss://rpc-testnet.monadinfra.com'],
      http: ['https://rpc-testnet.monadinfra.com', 'https://rpc.ankr.com/monad_testnet'],
      headsMethod: 'monadNewHeads',
      explorerTx: 'https://testnet.monadvision.com/tx/',
    } satisfies ChainConfig,
    replay: {
      chainId: 31337,
      badge: '本机重演',
      ws: ['ws://127.0.0.1:{anvil}'],
      http: ['http://127.0.0.1:{anvil}'],
      headsMethod: 'newHeads',
      explorerTx: null,
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
    { name: '以太坊', blockSec: 12, note: '约 12 秒/块' },
    { name: 'BSC', blockSec: 0.45, note: '约 0.45 秒/块' },
  ],
  delayBlocks: 30,
}
