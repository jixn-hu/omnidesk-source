/**
 * MCP Server —— 把 OmniDesk 的能力暴露给 AI 客户端
 *
 * 实现的是 MCP 的 Streamable HTTP 传输（无状态模式）：
 *   - 客户端 POST /mcp，body 是 JSON-RPC 2.0
 *   - 服务端直接返回 JSON 响应
 *   - GET / DELETE 返回 405（不支持 SSE 长连接，简化实现）
 *
 * 安全模型（这部分是重点，不是附属功能）：
 *   1. 默认不启动，需要在界面上手动开启
 *   2. Bearer Token 鉴权，每个客户端独立 token，可单独吊销
 *   3. 连接默认「不暴露」给 MCP，需要用户逐个授权
 *   4. 写操作走审批，在界面上确认（可对可信客户端关闭）
 *   5. 每次调用校验目标是否与授权时一致，防止授权后被篡改
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { Connection, ExternalScope, ServerMetrics } from '@shared/types.js'
import { APP_NAME } from '@shared/constants.js'
import { services } from '../services/index.js'
import { getPrimaryWindow } from '../windows.js'
import { IPC } from '@shared/ipc.js'

/** MCP 协议版本 */
const PROTOCOL_VERSION = '2025-06-18'

/** 支持的协议版本（客户端报什么，我们回什么——只要在列表里） */
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

let server: Server | null = null
let listening = false

/** 等待界面审批的请求 */
const pendingApprovals = new Map<string, (approved: boolean) => void>()

/** 记录每个连接被授权时的目标指纹，用于二次校验 */
const authorizedTargets = new Map<string, string>()

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

interface ToolDefinition {
  name: string
  title: string
  description: string
  scope: ExternalScope
  /** 是否是写操作（需要审批） */
  write: boolean
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}

interface ToolContext {
  tokenId: string
  scopes: ExternalScope[]
  skipApproval: boolean
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'list_connections',
    title: '列出可用主机',
    description:
      '列出用户已授权给 MCP 的 SSH 主机。只返回用户显式授权过的连接，未授权的主机不会出现。',
    scope: 'ssh:read',
    write: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const list = services.connections.exposed().filter((c) => c.kind === 'ssh')
      if (list.length === 0) {
        return {
          count: 0,
          hint: '当前没有授权给 MCP 的主机。请在 OmniDesk 界面中为连接打开「允许外部访问」开关。',
          connections: []
        }
      }
      return {
        count: list.length,
        connections: list.map((c) => ({
          id: c.id,
          name: c.name,
          host: c.host,
          port: c.port,
          group: c.group ?? null,
          note: c.note ?? null
        }))
      }
    }
  },

  {
    name: 'ssh_exec',
    title: '执行 Shell 命令',
    description:
      '在指定的 Linux 主机上执行一条 shell 命令并返回 stdout/stderr 与退出码。' +
      '适用于查看系统状态、读取日志、运行诊断命令。长时间运行的命令请配合 timeoutMs 使用。',
    scope: 'ssh:exec',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: '来自 list_connections 的连接 ID' },
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 30000' }
      },
      required: ['connectionId', 'command'],
      additionalProperties: false
    },
    handler: async (args, ctx) => {
      const connectionId = requireString(args, 'connectionId')
      const command = requireString(args, 'command')
      await approveWrite(ctx, 'ssh_exec', `${connectionId} :: ${truncate(command, 120)}`)
      const sessionId = await ensureAuthorizedSession(connectionId)
      return await services.ssh.exec(sessionId, command, {
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
      })
    }
  },

  {
    name: 'server_metrics',
    title: '获取服务器指标',
    description:
      '采集目标 Linux 主机的结构化运行指标：CPU（总体/分核/负载）、内存、磁盘、网络、' +
      '系统信息。返回可直接用于分析的 JSON，无需再解析文本。',
    scope: 'metrics:read',
    write: false,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: '来自 list_connections 的连接 ID' },
        withProcesses: { type: 'boolean', description: '是否包含 CPU 占用最高的进程列表' }
      },
      required: ['connectionId'],
      additionalProperties: false
    },
    handler: async (args) => {
      const connectionId = requireString(args, 'connectionId')
      const sessionId = await ensureAuthorizedSession(connectionId)
      const metrics = await services.metrics.collect(sessionId, args.withProcesses === true)
      return summarizeMetrics(metrics)
    }
  },

  {
    name: 'sftp_list',
    title: '列出远端目录',
    description: '列出指定主机上的目录内容，返回文件类型、大小、权限、修改时间。',
    scope: 'sftp:read',
    write: false,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: '连接 ID' },
        path: { type: 'string', description: '远端路径，默认家目录' }
      },
      required: ['connectionId'],
      additionalProperties: false
    },
    handler: async (args) => {
      const connectionId = requireString(args, 'connectionId')
      const path = typeof args.path === 'string' && args.path ? args.path : '.'
      const sessionId = await ensureAuthorizedSession(connectionId)
      const { path: resolved, entries } = await services.sftp.list(sessionId, path)
      return {
        path: resolved,
        count: entries.length,
        entries: entries.slice(0, 500).map((e) => ({
          name: e.name,
          type: e.type,
          size: e.size,
          mode: e.modeText,
          mtime: new Date(e.mtime).toISOString()
        }))
      }
    }
  },

  {
    name: 'sftp_read_text',
    title: '读取远端文本文件',
    description: '读取远端文本文件内容（上限 2MB）。适合读配置文件、日志片段。',
    scope: 'sftp:read',
    write: false,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: '连接 ID' },
        path: { type: 'string', description: '远端文件绝对路径' }
      },
      required: ['connectionId', 'path'],
      additionalProperties: false
    },
    handler: async (args) => {
      const connectionId = requireString(args, 'connectionId')
      const path = requireString(args, 'path')
      const sessionId = await ensureAuthorizedSession(connectionId)
      const content = await services.sftp.readFile(sessionId, path)
      return { path, bytes: Buffer.byteLength(content, 'utf8'), content }
    }
  },

  {
    name: 'systemd_logs',
    title: '读取 systemd 日志',
    description: '读取指定 unit 或全局的 systemd 日志。等价于 journalctl 的常用查询。',
    scope: 'ssh:read',
    write: false,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: '连接 ID' },
        unit: { type: 'string', description: 'unit 名称，如 nginx.service；留空则查全局' },
        lines: { type: 'number', description: '返回行数，默认 100，上限 2000' },
        since: { type: 'string', description: '起始时间，如 "1 hour ago" 或 "2026-10-14 10:00"' }
      },
      required: ['connectionId'],
      additionalProperties: false
    },
    handler: async (args) => {
      const connectionId = requireString(args, 'connectionId')
      const sessionId = await ensureAuthorizedSession(connectionId)

      const lines = Math.min(Math.max(Number(args.lines) || 100, 1), 2000)
      const parts = ['journalctl', '--no-pager', '-n', String(lines)]
      if (typeof args.unit === 'string' && args.unit) parts.push('-u', quote(args.unit))
      if (typeof args.since === 'string' && args.since) parts.push('--since', quote(args.since))
      // 非 root 用户读 journalctl 常需要提权，先试普通方式
      const result = await services.ssh.exec(sessionId, parts.join(' '), { timeoutMs: 20_000 })
      return {
        lines: result.stdout.split('\n').filter(Boolean).length,
        exitCode: result.code,
        output: result.stdout,
        stderr: result.stderr || undefined
      }
    }
  },

  {
    name: 'sftp_write_text',
    title: '写入远端文本文件',
    description: '把文本内容写入远端文件（覆盖）。属于写操作，需要用户审批。',
    scope: 'sftp:write',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: '连接 ID' },
        path: { type: 'string', description: '远端文件绝对路径' },
        content: { type: 'string', description: '文件内容' }
      },
      required: ['connectionId', 'path', 'content'],
      additionalProperties: false
    },
    handler: async (args, ctx) => {
      const connectionId = requireString(args, 'connectionId')
      const path = requireString(args, 'path')
      const content = requireString(args, 'content')
      await approveWrite(ctx, 'sftp_write_text', `${connectionId} :: ${path} (${Buffer.byteLength(content)} 字节)`)
      const sessionId = await ensureAuthorizedSession(connectionId)
      await services.sftp.writeFile(sessionId, path, content)
      return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') }
    }
  }
]

/* ------------------------------------------------------------------ */
/* 工具执行辅助                                                        */
/* ------------------------------------------------------------------ */

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || !v) throw new Error(`参数 ${key} 必填且必须是字符串`)
  return v
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 目标指纹：授权后如果连接配置被改动（比如 host 被换掉），指纹就变了 */
function targetFingerprint(conn: Connection): string {
  return createHash('sha256').update(`${conn.host}:${conn.port}:${conn.kind}`).digest('hex').slice(0, 16)
}

/**
 * 取会话前校验：连接必须已授权，且目标未被篡改。
 * 这是防止「先授权安全主机，之后偷偷改成生产机」这类攻击。
 */
async function ensureAuthorizedSession(connectionId: string): Promise<string> {
  const conn = services.connections.get(connectionId)
  if (!conn) throw new Error(`连接不存在：${connectionId}`)
  if (!conn.exposedToExternal) {
    throw new Error(`连接「${conn.name}」未授权给外部访问。请在 OmniDesk 界面中开启后再试。`)
  }

  const fp = targetFingerprint(conn)
  const recorded = authorizedTargets.get(connectionId)
  if (recorded && recorded !== fp) {
    throw new Error('已授权的目标与当前连接配置不一致，出于安全考虑拒绝执行。请重新授权。')
  }
  if (!recorded) authorizedTargets.set(connectionId, fp)

  return await services.ensureSession(connectionId)
}

/** 写操作审批：在界面上弹确认，等用户点 */
async function approveWrite(ctx: ToolContext, operation: string, detail: string): Promise<void> {
  if (ctx.skipApproval) return

  const win = getPrimaryWindow()
  if (!win || win.isDestroyed()) {
    throw new Error('界面不可用，无法完成审批。请打开 OmniDesk 主窗口后重试。')
  }

  const requestId = randomUUID()
  const approved = await new Promise<boolean>((resolve) => {
    pendingApprovals.set(requestId, resolve)
    win.webContents.send(IPC.push.externalApprovalRequest, {
      requestId,
      operation,
      detail
    })
    // 3 分钟无人处理视为拒绝
    setTimeout(() => {
      if (pendingApprovals.has(requestId)) {
        pendingApprovals.delete(requestId)
        resolve(false)
      }
    }, 180_000)
  })

  if (!approved) throw new Error(`用户拒绝了操作：${operation}`)
}

/** 指标裁剪：去掉体积大且 AI 用不上的字段，控制 token 消耗 */
function summarizeMetrics(m: ServerMetrics): unknown {
  return {
    timestamp: new Date(m.timestamp).toISOString(),
    system: m.system,
    cpu: {
      usagePercent: m.cpu.usage,
      cores: m.cpu.cores,
      loadAvg: m.cpu.loadAvg,
      model: m.cpu.model
    },
    memory: {
      totalBytes: m.memory.total,
      usedBytes: m.memory.used,
      availableBytes: m.memory.available,
      usagePercent: m.memory.usagePercent,
      swapTotalBytes: m.memory.swapTotal,
      swapUsedBytes: m.memory.swapUsed
    },
    disks: m.disks.map((d) => ({
      mount: d.mount,
      totalBytes: d.total,
      usedBytes: d.used,
      availableBytes: d.available,
      usagePercent: d.usagePercent
    })),
    network: m.network.map((n) => ({
      name: n.name,
      rxBytes: n.rxBytes,
      txBytes: n.txBytes,
      rxRateBps: n.rxRate,
      txRateBps: n.txRate
    })),
    processes: m.processes?.map((p) => ({
      pid: p.pid,
      user: p.user,
      cpuPercent: p.cpu,
      memPercent: p.mem,
      command: p.command
    }))
  }
}

/* ------------------------------------------------------------------ */
/* JSON-RPC 处理                                                       */
/* ------------------------------------------------------------------ */

async function handleRpc(req: RpcRequest, tokenScopes: ExternalScope[], tokenId: string, skipApproval: boolean): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'omnidesk', title: APP_NAME, version: '0.1.0' },
        instructions:
          'OmniDesk 提供对用户 Linux 主机的受控访问。先调用 list_connections 查看可用主机；' +
          '写操作会请求用户审批，被拒绝时不要重试。'
      }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return {}

    case 'tools/list':
      return {
        tools: TOOLS.filter((t) => tokenScopes.includes(t.scope)).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      }

    case 'tools/call': {
      const params = req.params ?? {}
      const name = params.name
      const args = (params.arguments ?? {}) as Record<string, unknown>
      if (typeof name !== 'string') {
        return rpcErrorContent('缺少工具名')
      }

      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) return rpcErrorContent(`未知工具：${name}`)
      if (!tokenScopes.includes(tool.scope)) {
        return rpcErrorContent(`当前令牌缺少权限：${tool.scope}`)
      }

      try {
        const result = await tool.handler(args, { tokenId, scopes: tokenScopes, skipApproval })
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `执行失败：${message}` }], isError: true }
      }
    }

    default:
      return null
  }
}

function rpcErrorContent(message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/* ------------------------------------------------------------------ */
/* HTTP 传输层                                                         */
/* ------------------------------------------------------------------ */

async function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders
  })
  res.end(body)
}

export async function startMcpServer(): Promise<void> {
  if (listening && server) return

  const cfg = services.settings.getExternalConfig().mcp
  const host = cfg.host || '127.0.0.1'
  const port = cfg.port

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)

    // 健康检查（无需鉴权，方便探活）
    if (url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok', server: 'omnidesk-mcp' })
      return
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (无状态模式仅支持 POST)' },
        id: null
      })
      return
    }

    // ---- 鉴权 ----
    const auth = String(req.headers['authorization'] ?? '')
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    if (!match) {
      sendJson(
        res,
        401,
        { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
        { 'www-authenticate': 'Bearer realm="OmniDesk MCP"' }
      )
      return
    }

    const token = services.settings.verifyToken('mcp', match[1]!.trim())
    if (!token) {
      sendJson(
        res,
        401,
        { jsonrpc: '2.0', error: { code: -32001, message: 'Invalid token' }, id: null },
        { 'www-authenticate': 'Bearer realm="OmniDesk MCP"' }
      )
      return
    }

    // ---- 解析 ----
    let rpc: RpcRequest
    try {
      const raw = await readBody(req)
      rpc = JSON.parse(raw) as RpcRequest
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
      return
    }

    // 通知类消息（无 id）不需要响应体
    if (rpc.id === undefined || rpc.id === null) {
      await handleRpc(rpc, token.scopes, token.id, token.allowWriteWithoutApproval === true).catch(() => null)
      res.writeHead(202)
      res.end()
      return
    }

    // ---- 处理 ----
    try {
      const result = await handleRpc(rpc, token.scopes, token.id, token.allowWriteWithoutApproval === true)
      sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpc.id,
        error: { code: -32603, message }
      })
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
  console.log(`[mcp] 已启动 http://${host}:${port}/mcp`)
}

export async function stopMcpServer(): Promise<void> {
  if (!server) return
  const s = server
  server = null
  listening = false
  await new Promise<void>((resolve) => {
    s.close(() => resolve())
    s.closeAllConnections?.()
  })
  console.log('[mcp] 已停止')
}

export function isMcpRunning(): boolean {
  return listening
}

/** 供 IPC 层回传审批结果 */
export function resolveApproval(requestId: string, approved: boolean): boolean {
  const fn = pendingApprovals.get(requestId)
  if (!fn) return false
  pendingApprovals.delete(requestId)
  fn(approved)
  return true
}
