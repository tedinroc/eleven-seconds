// 由 config + URL 参数算出本次执行的设定（浏览器端）。
import { CONFIG, type AppMode, type ChainConfig, type ServiceName } from './config'

const params = new URLSearchParams(location.search)

function pickMode(): AppMode {
  const m = params.get('mode')
  if (m === 'testnet' || m === 'replay' || m === 'fake' || m === 'chain') return m
  // 云端版（vite build --mode cloud）默认链上只读；本机 dev/build 照旧
  if (import.meta.env?.MODE === 'cloud') return 'chain'
  return CONFIG.defaultMode
}

export const MODE: AppMode = pickMode()

const anvilPort = Number(params.get('anvil') ?? CONFIG.defaultAnvilPort) || CONFIG.defaultAnvilPort

function fill(urls: string[]): string[] {
  return urls.map((u) => u.replace('{anvil}', String(anvilPort)))
}

/** fake 模式模拟测试网的四段状态条（用来验证画面），但徽章另标「假事件演示」 */
const base: ChainConfig = MODE === 'replay' ? CONFIG.chains.replay : MODE === 'chain' ? CONFIG.chains.chain : CONFIG.chains.testnet
export const CHAIN: ChainConfig = { ...base, ws: fill(base.ws), http: fill(base.http) }

/** 是否有 Monad 四段 commitState（本机 anvil 没有） */
export const HAS_COMMIT_STATE = MODE !== 'replay'

/** 链上只读（云端版）：不连本机服务、不显示提案按钮 */
export const READ_ONLY = MODE === 'chain'

/** 数字与哈希来自真实测试网（可以连到区块浏览器） */
export const ON_TESTNET = MODE === 'testnet' || MODE === 'chain'

/** 本机数字标注：replay 与 fake 都不是测试网实测 */
export const LOCAL_TAG = MODE === 'replay' ? '本机' : MODE === 'fake' ? '假数据' : ''

export function svcUrl(name: ServiceName, path: string): string {
  if (CONFIG.viaProxy) return `/svc/${name}${path}`
  return `${CONFIG.services[name]}${path}`
}

export const SERVICE_NAMES = Object.keys(CONFIG.services) as ServiceName[]
export const SENTINELS: ServiceName[] = ['sentinel-1', 'sentinel-2', 'sentinel-3']
