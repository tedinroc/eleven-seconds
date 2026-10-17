// 版面自适应。宽屏横式（宽 ≥ 1100 且 宽/高 ≥ 1.3）维持 1280×720 固定舞台等比缩放（ui.ts fitStage），
// 本档完全不介入；其余情况（平板直式、手机、窄视窗）给 <html> 加 .layout-stack，
// 由 style.css 末段把舞台改成可垂直卷动的堆叠版面（覆盖 fitStage 写的 inline transform）。
// 由 index.html 以独立 <script type="module"> 载入，自我初始化。

const WIDE_MIN_W = 1100
const WIDE_MIN_RATIO = 1.3
const STACK_CLASS = 'layout-stack'

function isWide(w: number, h: number): boolean {
  return w >= WIDE_MIN_W && w / Math.max(1, h) >= WIDE_MIN_RATIO
}

function apply() {
  const root = document.documentElement
  const stack = !isWide(window.innerWidth, window.innerHeight)
  if (root.classList.contains(STACK_CLASS) === stack) return
  root.classList.toggle(STACK_CLASS, stack)
  // 回到舞台模式时把卷动位置归零，舞台从视窗左上角开始算
  if (!stack) window.scrollTo(0, 0)
}

// 节流：连续 resize / 转向只在停下后 120ms 内切换一次
let timer = 0
function schedule() {
  if (timer) return
  timer = window.setTimeout(() => {
    timer = 0
    apply()
  }, 120)
}

apply()
window.addEventListener('resize', schedule, { passive: true })
window.addEventListener('orientationchange', schedule)
window.matchMedia('(orientation: portrait)').addEventListener('change', schedule)
