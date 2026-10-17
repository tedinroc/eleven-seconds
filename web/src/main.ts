import './style.css'
import { publicClient } from './chain'

const app = document.querySelector<HTMLDivElement>('#app')!

async function main() {
  try {
    const chainId = await publicClient.getChainId()
    publicClient.watchBlockNumber({
      emitOnBegin: true,
      onBlockNumber: (n) => {
        app.textContent = `connected to chain ${chainId}, block ${n}`
      },
      onError: (e) => {
        app.textContent = `rpc error: ${e.message}`
      },
    })
  } catch (e) {
    app.textContent = `not connected: ${(e as Error).message}`
  }
}

main()
