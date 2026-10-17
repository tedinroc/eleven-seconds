// dev 与 preview 都把 /svc/<name>/… 代理到 config.ts 里的本机服务，浏览器同源访问、免 CORS。
// 临时改端口（不改设定档）：WARROOM_SERVICES='{"driver":"http://127.0.0.1:8790"}' npm run dev
import { defineConfig } from 'vite'
import { CONFIG } from './src/config.ts'

const services: Record<string, string> = { ...CONFIG.services, ...JSON.parse(process.env.WARROOM_SERVICES || '{}') }
const proxy = Object.fromEntries(
  Object.entries(services).map(([name, target]) => [
    `/svc/${name}`,
    { target, changeOrigin: true, rewrite: (p: string) => p.replace(`/svc/${name}`, '') },
  ]),
)

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
})
