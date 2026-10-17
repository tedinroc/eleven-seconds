// Node 里跑前端逻辑用的最小浏览器替身：只给 runtime.ts / fake.ts 会碰到的东西。
// 必须是 selftest.ts 的第一个 import（ESM 依 import 顺序执行）。
const g = globalThis as unknown as Record<string, unknown>
g.location = { search: '?mode=fake' }
g.window = globalThis
export {}
