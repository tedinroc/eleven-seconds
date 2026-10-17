// Monad testnet chain definition + multi-RPC fallback transport (generic boilerplate).
// Override the RPC list at build time with VITE_RPC_URLS="https://a,https://b".
import { createPublicClient, defineChain, fallback, http } from 'viem'

const DEFAULT_RPCS = [
  'https://testnet-rpc.monad.xyz',
  'https://rpc-testnet.monadinfra.com',
  'https://rpc.ankr.com/monad_testnet',
  'https://monad-testnet.drpc.org',
]

const envRpcs = (import.meta.env.VITE_RPC_URLS as string | undefined)
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export const RPC_URLS: string[] = envRpcs && envRpcs.length > 0 ? envRpcs : DEFAULT_RPCS

export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  blockExplorers: {
    default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' },
  },
  testnet: true,
})

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: fallback(
    RPC_URLS.map((url) => http(url, { timeout: 4_000, retryCount: 1 })),
    { rank: false },
  ),
  pollingInterval: 400,
})
