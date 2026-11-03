/**
 * HTTP API —— 给外部系统提供数据
 *
 * 与 MCP 的分工：
 *   MCP  → 面向 AI 客户端，工具调用语义
 *   API  → 面向程序/看板/告警系统，REST + SSE
 *
 * 两者共用同一套服务层，所以拿到的数据必然一致。
 *
 * 安全：只绑 127.0.0.1，Bearer Token 鉴权，令牌独立于 MCP 令牌。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { ExternalScope } from '@shared/types.js'
import { services } from '../services/index.js'

let server: Server | null = null
let listening = false

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

interface Route {
  method: 'GET' | 'POST'
  /** 形如 /api/v1/hosts/:id/metrics */
  pattern: string
  scope: ExternalScope
  handler: (ctx: RouteContext) => Promise<unknown>
}

interface RouteContext {
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: '/api/v1/health',
    scope: 'metrics:read',
    handler: async () => ({
      status: 'ok',
      uptime: process.uptime(),
      version: '0.1.0'
    })
  },

  {
    method: 'GET',
    pattern: '/api/v1/hosts',
    scope: 'ssh:read',
    handler: async () => {
      const list = services.connections.exposed()
      return {
        count: list.length,
        hosts: list.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          host: c.host,
          port: c.port,
          group: c.group ?? null
        }))
      }
    }
  },

  {
    method: 'GET',
    pattern: '/api/v1/hosts/:id/metrics',
    scope: 'metrics:read',
    handler: async (ctx) => {
      const sessionId = await requireSession(ctx.params.id!)
      return await services.metrics.collect(sessionId, ctx.query.get('processes') === '1')
    }
  },

  {
    method: 'GET',
    pattern: '/api/v1/hosts/:id/metrics/summary',
    scope: 'metrics:read',
    handler: async (ctx) => {
      const sessionId = await requireSession(ctx.params.id!)
      const m = await services.metrics.collect(sessionId, false)
      // 精简版：适合看板/告警轮询
      return {
        host: m.system.hostname,
        timestamp: m.timestamp,
        cpu: m.cpu.usage,
        load: m.cpu.loadAvg,
        memory: m.memory.usagePercent,
        disks: m.disks.map((d) => ({ mount: d.mount, usage: d.usagePercent })),
        network: m.network.map((n) => ({ name: n.name, rxRate: n.rxRate, txRate: n.txRate }))
      }
    }
  },

  {
    method: 'POST',
    pattern: '/api/v1/hosts/:id/exec',
    scope: 'ssh:exec',
    handler: async (ctx) => {
      const body = (ctx.body ?? {}) as { command?: string; timeoutMs?: number }
      if (!body.command) throw new HttpError(400, 'command 字段必填')
      const sessionId = await requireSession(ctx.params.id!)
      return await services.ssh.exec(sessionId, body.command, { timeoutMs: body.timeoutMs })
    }
  },

  {
    method: 'GET',
    pattern: '/api/v1/hosts/:id/processes',
    scope: 'metrics:read',
    handler: async (ctx) => {
      const sessionId = await requireSession(ctx.params.id!)
      const m = await services.metrics.collect(sessionId, true)
      return { host: m.system.hostname, timestamp: m.timestamp, processes: m.processes ?? [] }
    }
  },

  {
    method: 'GET',
    pattern: '/api/v1/rdp/status',
    scope: 'metrics:read',
    handler: async () => services.rdp.getStatus()
  }
]

/* ------------------------------------------------------------------ */
/* SSE：实时指标流                                                     */
/* ------------------------------------------------------------------ */

/** 形如 /api/v1/hosts/:id/metrics/stream 的订阅 */
function matchStreamRoute(pathname: string): Record<string, string> | null {
  const m = /^\/api\/v1\/hosts\/([^/]+)\/metrics\/stream$/.exec(pathname)
  return m ? { id: m[1]! } : null
}

async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  connectionId: string,
  query: URLSearchParams
): Promise<void> {
  const intervalMs = Math.min(Math.max(Number(query.get('interval')) || 3000, 1000), 60_000)

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })

  let closed = false
  req.on('close', () => {
    closed = true
  })

  const tick = async () => {
    if (closed) return
    try {
      const sessionId = await requireSession(connectionId)
      const m = await services.metrics.collect(sessionId, false)
      const payload = {
        host: m.system.hostname,
        timestamp: m.timestamp,
        cpu: m.cpu.usage,
        load: m.cpu.loadAvg,
        memory: m.memory.usagePercent,
        disks: m.disks.map((d) => ({ mount: d.mount, usage: d.usagePercent })),
        network: m.network.map((n) => ({ name: n.name, rxRate: n.rxRate, txRate: n.txRate }))
      }
      res.write(`event: metrics\ndata: ${JSON.stringify(payload)}\n\n`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`)
    }
    if (!closed) setTimeout(tick, intervalMs)
  }

  void tick()
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

async function requireSession(connectionId: string): Promise<string> {
  const conn = services.connections.get(connectionId)
  if (!conn) throw new HttpError(404, `主机不存在：${connectionId}`)
  if (!conn.exposedToExternal) {
    throw new HttpError(403, `主机「${conn.name}」未授权给外部访问`)
  }
  if (conn.kind !== 'ssh') throw new HttpError(400, '该主机不是 SSH 类型')
  return await services.ensureSession(connectionId)
}

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const params = matchPattern(route.pattern, pathname)
    if (params) return { route, params }
  }
  return null
}

function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const pParts = pattern.split('/')
  const tParts = pathname.split('/')
  if (pParts.length !== tParts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pParts.length; i++) {
    const p = pParts[i]!
    const t = tParts[i]!
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(t)
    else if (p !== t) return null
  }
  return params
}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers
  })
  res.end(body)
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

export async function startApiServer(): Promise<void> {
  if (listening && server) return

  const cfg = services.settings.getExternalConfig().api
  const host = cfg.host || '127.0.0.1'
  const port = cfg.port

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    const pathname = url.pathname

    try {
      // ---- 鉴权（health 除外）----
      if (pathname !== '/api/v1/health') {
        const auth = String(req.headers['authorization'] ?? '')
        const m = /^Bearer\s+(.+)$/i.exec(auth)
        if (!m) {
          sendJson(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer realm="OmniDesk API"' })
          return
        }
        const token = services.settings.verifyToken('api', m[1]!.trim())
        if (!token) {
          sendJson(res, 401, { error: 'Invalid token' }, { 'www-authenticate': 'Bearer realm="OmniDesk API"' })
          return
        }

        // ---- SSE 流 ----
        const streamParams = matchStreamRoute(pathname)
        if (streamParams && req.method === 'GET') {
          if (!token.scopes.includes('metrics:read')) {
            sendJson(res, 403, { error: '令牌缺少 metrics:read 权限' })
            return
          }
          await handleStream(req, res, streamParams.id!, url.searchParams)
          return
        }

        // ---- 普通路由 ----
        const matched = matchRoute(req.method ?? 'GET', pathname)
        if (!matched) {
          sendJson(res, 404, { error: `无此端点：${req.method} ${pathname}` })
          return
        }
        if (!token.scopes.includes(matched.route.scope)) {
          sendJson(res, 403, { error: `令牌缺少权限：${matched.route.scope}` })
          return
        }

        const body = req.method === 'POST' ? await readBody(req) : undefined
        const result = await matched.route.handler({
          params: matched.params,
          query: url.searchParams,
          body
        })
        sendJson(res, 200, result)
        return
      }

      // ---- health ----
      sendJson(res, 200, { status: 'ok', server: 'omnidesk-api', version: '0.1.0' })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        sendJson(res, 500, { error: message })
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(port, host, () => {
      server!.removeListener('error', reject)
      resolve()
    })
  })

  listening = true
  console.log(`[api] 已启动 http://${host}:${port}/api/v1`)
}

export async function stopApiServer(): Promise<void> {
  if (!server) return
  const s = server
  server = null
  listening = false
  await new Promise<void>((resolve) => {
    s.close(() => resolve())
    s.closeAllConnections?.()
  })
  console.log('[api] 已停止')
}

export function isApiRunning(): boolean {
  return listening
}

/** 导出 OpenAPI 描述，方便其他系统对接 */
export function openApiDocument(): unknown {
  const paths: Record<string, unknown> = {}
  for (const r of routes) {
    const key = r.pattern
    const method = r.method.toLowerCase()
    paths[key] = {
      ...(paths[key] as Record<string, unknown> | undefined),
      [method]: {
        summary: r.pattern,
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'OK' } }
      }
    }
  }
  return {
    openapi: '3.0.3',
    info: { title: 'OmniDesk API', version: '0.1.0' },
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' }
      }
    },
    paths
  }
}
