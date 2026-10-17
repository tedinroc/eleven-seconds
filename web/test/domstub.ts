// 自测用的最小 DOM 替身：getElementById 对任何 id 都给一个只记 innerHTML 的假元素，
// 够 ui.render() 在 Node 里跑完一遍，好检查各语言渲染出的 HTML。不模拟排版（autoFit 直接跳过）。
interface FakeEl {
  id: string
  innerHTML: string
  style: Record<string, unknown>
  classList: { toggle(c: string, on?: boolean): boolean; contains(c: string): boolean; add(c: string): void; remove(c: string): void }
  querySelector(): null
  closest(): null
  clientHeight: number
}

function makeEl(id: string): FakeEl {
  const cls = new Set<string>()
  return {
    id,
    innerHTML: '',
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      toggle(c, on) {
        const want = on ?? !cls.has(c)
        if (want) cls.add(c)
        else cls.delete(c)
        return want
      },
      contains: (c) => cls.has(c),
      add: (c) => void cls.add(c),
      remove: (c) => void cls.delete(c),
    },
    querySelector: () => null,
    closest: () => null,
    clientHeight: 0,
  }
}

export function installDom() {
  const g = globalThis as unknown as Record<string, unknown>
  const els = new Map<string, FakeEl>()
  const doc = {
    title: '',
    documentElement: { lang: '' },
    getElementById(id: string) {
      let e = els.get(id)
      if (!e) els.set(id, (e = makeEl(id)))
      return e
    },
    addEventListener() {},
    visibilityState: 'visible',
  }
  const mem = new Map<string, string>()
  g.document = doc
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  }
  if (typeof g.addEventListener !== 'function') g.addEventListener = () => {}
  return {
    doc,
    els,
    mem,
    /** 目前所有区块的 innerHTML 串在一起（＝整个画面） */
    html: () => [...els.values()].map((e) => e.innerHTML).join('\n'),
  }
}
