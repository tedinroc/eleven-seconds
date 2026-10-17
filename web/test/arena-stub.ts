// arena-selftest.ts 的第一个 import：在 runtime.ts 读网址之前把模式设成 ?mode=arena。
const g = globalThis as unknown as Record<string, unknown>
g.location = { search: '?mode=arena', href: 'http://localhost/?mode=arena' }
g.window = globalThis
export {}
