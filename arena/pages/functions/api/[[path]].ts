// Cloudflare Pages Function（Pages 专案 eleven-seconds-arena）：/api/* 是云端互动版战情室的 API。
// 收到的 Request 原样（method、路径、query、标头含 CF-Connecting-IP、body）经 service binding「ARENA」
// 转发给 arena 引擎 Worker（eleven-seconds-arena-engine，workers_dev = false，没有自己的公开网址）。
// 限流（每位访客 45 秒、同时只跑一个提案、每小时／每日上限）与 CORS 都在 Worker；这里不加也不减。
// 只有 /api/* 会叫用 Function（wrangler 依 functions/ 目录产生 _routes.json），静态档不经过这里。

export interface ServiceBinding {
  fetch(request: Request): Promise<Response>
}

export interface Env {
  ARENA?: ServiceBinding
  /** 引擎 README 范例用的名称，也接受 */
  ARENA_ENGINE?: ServiceBinding
}

export const onRequest = async (ctx: { request: Request; env: Env }): Promise<Response> => {
  const svc = ctx.env.ARENA ?? ctx.env.ARENA_ENGINE
  if (!svc) {
    return new Response(JSON.stringify({ ok: false, error: 'ARENA binding not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  return svc.fetch(ctx.request)
}
