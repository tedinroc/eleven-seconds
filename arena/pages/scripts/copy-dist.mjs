// web/dist-arena → arena/pages/dist（wrangler.toml 的 pages_build_output_dir）
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', '..', '..', 'web', 'dist-arena')
const dst = join(here, '..', 'dist')
if (!existsSync(join(src, 'index.html'))) {
  console.error('web/dist-arena/index.html 不存在：先跑 npm --prefix ../../web run build:arena')
  process.exit(1)
}
rmSync(dst, { recursive: true, force: true })
cpSync(src, dst, { recursive: true })
console.log('dist：已从 web/dist-arena 复制')
