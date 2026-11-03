/**
 * SSH 端口转发服务
 *
 * 三种转发，对应 ssh 命令的三个参数：
 *
 *   local   (-L)  本机监听 → 经 SSH 隧道 → 远端可达的目标
 *                 用途：把远端内网服务（如远端 127.0.0.1:3306）映射到本机
 *
 *   remote  (-R)  远端监听 → 经 SSH 隧道 → 本机可达的目标
 *                 用途：把本机服务暴露给远端（也可配合远端做跳板）
 *
 *   dynamic (-D)  本机开一个 SOCKS5 → 流量从远端出去
 *                 用途：以这台机器为网络出口。这就是"针对这一个远程做 VPN"的正解
 *
 * 动态转发的意义值得强调：它不是把某个端口映射过去，而是让本机任意程序
 * 都能"以远端为出口"访问网络 —— 效果上等价于只对这台机器生效的 VPN，
 * 不需要装驱动、不需要管理员权限。
 */
import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import type { PortForwardRule, PortForwardStatus } from '@shared/types.js'
import type { SshService } from './ssh.js'

/** 运行中的转发实例 */
interface ForwardRuntime {
  rule: PortForwardRule
  sessionId: string
  /** 本机监听的 server（local / dynamic） */
  server?: Server
  /** 远端监听的地址端口（remote） */
  remoteBind?: { host: string; port: number }
  connections: number
  bytesIn: number
  bytesOut: number
  startedAt: number
  /** 活跃的管道，停止时统一清理 */
  pipes: Set<() => void>
}

export class PortForwardService extends EventEmitter {
  private rules = new Map<string, PortForwardRule>()
  private runtimes = new Map<string, ForwardRuntime>()
  /** remote 类型的入站连接处理需要按 client 注册，避免重复绑定 */
  private remoteHandlers = new Map<string, (info: unknown, accept: () => ClientChannel, reject: () => void) => void>()

  constructor(
    private ssh: SshService,
    private loadRules: () => PortForwardRule[],
    private saveRules: (rules: PortForwardRule[]) => void
  ) {
    super()
    for (const r of loadRules()) this.rules.set(r.id, r)
  }

  /* ---------------------------------------------------------------- */
  /* 规则管理                                                          */
  /* ---------------------------------------------------------------- */

  list(connectionId?: string): PortForwardRule[] {
    const all = [...this.rules.values()]
    return connectionId ? all.filter((r) => r.connectionId === connectionId) : all
  }

  get(ruleId: string): PortForwardRule | null {
    return this.rules.get(ruleId) ?? null
  }

  save(input: PortForwardRule): PortForwardRule {
    const rule: PortForwardRule = {
      ...input,
      id: input.id || randomUUID()
    }
    validateRule(rule)
    this.rules.set(rule.id, rule)
    this.persist()
    return rule
  }

  async remove(ruleId: string): Promise<void> {
    this.stop(ruleId)
    this.rules.delete(ruleId)
    this.persist()
  }

  private persist(): void {
    this.saveRules([...this.rules.values()])
  }

  /* ---------------------------------------------------------------- */
  /* 启停                                                              */
  /* ---------------------------------------------------------------- */

  /** 启动一条转发规则，返回实际监听端口（端口填 0 时由系统分配） */
  async start(ruleId: string): Promise<PortForwardStatus> {
    const rule = this.rules.get(ruleId)
    if (!rule) throw new Error('转发规则不存在')

    // 已在运行就先停掉，避免端口冲突
    if (this.runtimes.has(ruleId)) this.stop(ruleId)

    const sessionId = await this.ensureSession(rule.connectionId)

    let runtime: ForwardRuntime
    switch (rule.kind) {
      case 'local':
        runtime = await this.startLocal(rule, sessionId)
        break
      case 'remote':
        runtime = await this.startRemote(rule, sessionId)
        break
      case 'dynamic':
        runtime = await this.startDynamic(rule, sessionId)
        break
      default:
        throw new Error(`未知的转发类型：${(rule as { kind: string }).kind}`)
    }

    this.runtimes.set(ruleId, runtime)
    this.emit('status', this.statusOf(ruleId))
    return this.statusOf(ruleId)!
  }

  stop(ruleId: string): void {
    const rt = this.runtimes.get(ruleId)
    if (!rt) return

    for (const cleanup of rt.pipes) {
      try {
        cleanup()
      } catch {
        /* ignore */
      }
    }
    rt.pipes.clear()

    if (rt.server) {
      try {
        rt.server.close()
      } catch {
        /* ignore */
      }
    }

    // 撤销远端监听
    if (rt.remoteBind) {
      try {
        const client = this.ssh.getClient(rt.sessionId)
        client.unforwardIn(rt.remoteBind.host, rt.remoteBind.port, () => {
          /* 尽力而为 */
        })
      } catch {
        /* 会话可能已断 */
      }
      const key = `${rt.sessionId}:${rt.remoteBind.host}:${rt.remoteBind.port}`
      this.remoteHandlers.delete(key)
    }

    this.runtimes.delete(ruleId)
    this.emit('status', this.statusOf(ruleId))
  }

  stopAll(): void {
    for (const id of [...this.runtimes.keys()]) this.stop(id)
  }

  private async ensureSession(connectionId: string): Promise<string> {
    const existing = this.ssh.findByConnectionId(connectionId)
    if (existing) return existing
    throw new Error('该主机尚未建立 SSH 会话。请先打开它的终端，再启动转发。')
  }

  /* ---------------------------------------------------------------- */
  /* 本地转发  -L                                                     */
  /* ---------------------------------------------------------------- */

  private async startLocal(rule: PortForwardRule, sessionId: string): Promise<ForwardRuntime> {
    if (!rule.targetHost || !rule.targetPort) {
      throw new Error('本地转发需要指定目标地址与端口')
    }
    const client = this.ssh.getClient(sessionId)

    const server = createServer((socket) => {
      const rt = this.runtimes.get(rule.id)
      if (!rt) {
        socket.destroy()
        return
      }
      rt.connections++

      client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        rule.targetHost!,
        rule.targetPort!,
        (err, stream) => {
          if (err) {
            this.emit('error', { ruleId: rule.id, message: `转发失败：${err.message}` })
            socket.destroy()
            return
          }
          this.wire(socket, stream, rt)
          this.emit('status', this.statusOf(rule.id))
        }
      )
    })

    const actualPort = await this.listen(server, rule.listenHost, rule.listenPort)

    return {
      rule,
      sessionId,
      server,
      connections: 0,
      bytesIn: 0,
      bytesOut: 0,
      startedAt: Date.now(),
      pipes: new Set()
    }
  }

  /* ---------------------------------------------------------------- */
  /* 远程转发  -R                                                     */
  /* ---------------------------------------------------------------- */

  private async startRemote(rule: PortForwardRule, sessionId: string): Promise<ForwardRuntime> {
    if (!rule.targetHost || !rule.targetPort) {
      throw new Error('远程转发需要指定本机目标地址与端口')
    }
    const client = this.ssh.getClient(sessionId)
    const listenHost = rule.listenHost || '127.0.0.1'

    // 先登记运行时，让 tcp connection 回调能拿到它
    const rt: ForwardRuntime = {
      rule,
      sessionId,
      connections: 0,
      bytesIn: 0,
      bytesOut: 0,
      startedAt: Date.now(),
      pipes: new Set()
    }
    this.runtimes.set(rule.id, rt)

    const actualPort = await new Promise<number>((resolve, reject) => {
      client.forwardIn(listenHost, rule.listenPort, (err, port) => {
        if (err) reject(new Error(`远端拒绝监听：${err.message}`))
        else resolve(port)
      })
    })

    rt.remoteBind = { host: listenHost, port: actualPort }

    // 远端有连接进来时，转发到本机目标
    const key = `${sessionId}:${listenHost}:${actualPort}`
    const handler = (
      info: unknown,
      accept: () => ClientChannel,
      reject: () => void
    ): void => {
      const { destPort } = info as { destPort: number }
      // 只接管本规则监听的端口
      if (destPort !== actualPort) return

      const channel = accept()
      rt.connections++

      const local = require('node:net').connect({
        host: rule.targetHost,
        port: rule.targetPort
      }) as Socket

      local.once('connect', () => {
        this.wire(local, channel, rt)
        this.emit('status', this.statusOf(rule.id))
      })
      local.once('error', (err: Error) => {
        this.emit('error', { ruleId: rule.id, message: `本机目标连接失败：${err.message}` })
        try {
          channel.close()
        } catch {
          /* ignore */
        }
      })
    }

    this.remoteHandlers.set(key, handler)
    client.on('tcp connection', handler)

    return rt
  }

  /* ---------------------------------------------------------------- */
  /* 动态转发  -D  （本机 SOCKS5，出口在远端）                          */
  /* ---------------------------------------------------------------- */

  private async startDynamic(rule: PortForwardRule, sessionId: string): Promise<ForwardRuntime> {
    const client = this.ssh.getClient(sessionId)

    const server = createServer((socket) => {
      const rt = this.runtimes.get(rule.id)
      if (!rt) {
        socket.destroy()
        return
      }
      void this.handleSocksConnection(socket, client, rt)
    })

    const actualPort = await this.listen(server, rule.listenHost || '127.0.0.1', rule.listenPort)

    return {
      rule,
      sessionId,
      server,
      connections: 0,
      bytesIn: 0,
      bytesOut: 0,
      startedAt: Date.now(),
      pipes: new Set()
    }
  }

  /**
   * 最小可用的 SOCKS5 服务端。
   *
   * 只实现 CONNECT 指令 —— 动态转发场景下 UDP ASSOCIATE 和 BIND 都用不到，
   * 实现了反而增加出错面。认证方式固定为「无认证」，因为监听地址
   * 默认是 127.0.0.1，本机程序本来就有权限。
   */
  private async handleSocksConnection(
    socket: Socket,
    client: Client,
    rt: ForwardRuntime
  ): Promise<void> {
    const ruleId = rt.rule.id
    let stage = 'greeting'

    try {
      // ① 握手：版本 + 方法数 + 方法列表
      const greeting = await readN(socket, 2, 10_000)
      if (greeting[0] !== 0x05) {
        socket.destroy()
        return
      }
      const nMethods = greeting[1]!
      const methods = nMethods > 0 ? await readN(socket, nMethods, 10_000) : Buffer.alloc(0)
      if (!methods.includes(0x00)) {
        socket.end(Buffer.from([0x05, 0xff]))
        return
      }
      // 只支持「无认证」
      socket.write(Buffer.from([0x05, 0x00]))

      // ② 请求：版本 + 指令 + 保留 + 地址类型 + 地址 + 端口
      stage = 'request'
      const head = await readN(socket, 4, 10_000)
      if (head[0] !== 0x05) {
        socket.destroy()
        return
      }
      if (head[1] !== 0x01) {
        // 非 CONNECT 指令
        socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        socket.destroy()
        return
      }

      const atyp = head[3]
      let host: string
      if (atyp === 0x01) {
        const b = await readN(socket, 4, 10_000)
        host = `${b[0]}.${b[1]}.${b[2]}.${b[3]}`
      } else if (atyp === 0x03) {
        const len = (await readN(socket, 1, 10_000))[0]!
        host = (await readN(socket, len, 10_000)).toString('utf8')
      } else if (atyp === 0x04) {
        const b = await readN(socket, 16, 10_000)
        const groups: string[] = []
        for (let i = 0; i < 16; i += 2) groups.push(((b[i]! << 8) | b[i + 1]!).toString(16))
        host = groups.join(':')
      } else {
        socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        socket.destroy()
        return
      }

      const portBuf = await readN(socket, 2, 10_000)
      const port = portBuf.readUInt16BE(0)

      // ③ 经 SSH 隧道连目标
      stage = 'forward'
      await new Promise<void>((resolve) => {
        client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          if (err) {
            // 0x05 = 连接被拒绝
            socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            socket.destroy()
            resolve()
            return
          }
          // 成功回复：绑定地址填 0.0.0.0:0（客户端一般不关心）
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          rt.connections++
          this.wire(socket, stream, rt)
          this.emit('status', this.statusOf(ruleId))
          resolve()
        })
      })
    } catch (err) {
      // 握手阶段出错就断开，不给客户端留下半开连接
      if (stage !== 'forward') {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 管道                                                              */
  /* ---------------------------------------------------------------- */

  /** 把本机 socket 与 SSH 通道对接，双向转发并统计流量 */
  private wire(socket: Socket, stream: ClientChannel, rt: ForwardRuntime): void {
    let closed = false

    const cleanup = (): void => {
      if (closed) return
      closed = true
      rt.pipes.delete(cleanup)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      try {
        stream.close()
      } catch {
        /* ignore */
      }
    }

    rt.pipes.add(cleanup)

    socket.on('data', (chunk: Buffer) => {
      rt.bytesOut += chunk.length
      if (!stream.destroyed) stream.write(chunk)
    })
    stream.on('data', (chunk: Buffer) => {
      rt.bytesIn += chunk.length
      if (!socket.destroyed) socket.write(chunk)
    })

    socket.on('close', cleanup)
    socket.on('error', cleanup)
    stream.on('close', cleanup)
    stream.on('error', cleanup)
    socket.resume()
  }

  /** 监听并返回实际端口（端口传 0 时由系统分配） */
  private async listen(server: Server, host: string, port: number): Promise<number> {
    const bindHost = host || '127.0.0.1'
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening)
        reject(
          err.message.includes('EADDRINUSE')
            ? new Error(`端口 ${port} 已被占用，请换一个端口`)
            : err
        )
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, bindHost)
    })

    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('无法确定监听端口')
    return addr.port
  }

  /* ---------------------------------------------------------------- */
  /* 状态                                                              */
  /* ---------------------------------------------------------------- */

  statusOf(ruleId: string): PortForwardStatus | null {
    const rule = this.rules.get(ruleId)
    if (!rule) return null
    const rt = this.runtimes.get(ruleId)
    if (!rt) return { ruleId, running: false, connections: 0, bytesIn: 0, bytesOut: 0 }

    let actualPort: number | undefined
    if (rt.server) {
      const addr = rt.server.address()
      if (addr && typeof addr !== 'string') actualPort = addr.port
    } else if (rt.remoteBind) {
      actualPort = rt.remoteBind.port
    }

    return {
      ruleId,
      running: true,
      actualPort,
      connections: rt.connections,
      bytesIn: rt.bytesIn,
      bytesOut: rt.bytesOut,
      startedAt: rt.startedAt
    }
  }

  statusAll(): PortForwardStatus[] {
    return this.list().map((r) => this.statusOf(r.id)!).filter(Boolean)
  }

  /** SSH 会话断开时清理相关转发 */
  onSessionClosed(sessionId: string): void {
    for (const [ruleId, rt] of this.runtimes) {
      if (rt.sessionId === sessionId) {
        this.stop(ruleId)
        this.emit('error', { ruleId, message: 'SSH 会话已断开，转发已停止' })
      }
    }
  }

  dispose(): void {
    this.stopAll()
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function validateRule(rule: PortForwardRule): void {
  if (!rule.connectionId) throw new Error('必须指定所属连接')

  const portOk = (p: number): boolean => Number.isInteger(p) && p >= 0 && p <= 65535
  if (!portOk(rule.listenPort)) throw new Error('监听端口需为 0 - 65535 之间的整数')

  if (rule.kind === 'local' || rule.kind === 'remote') {
    if (!rule.targetHost?.trim()) throw new Error('目标地址不能为空')
    if (!rule.targetPort || !portOk(rule.targetPort) || rule.targetPort === 0) {
      throw new Error('目标端口需为 1 - 65535 之间的整数')
    }
  }

  // 监听地址安全性：非回环地址意味着局域网可访问，这里只做提示不阻止，
  // 但 UI 必须给出警告
}

/** 精确读取 n 字节 */
function readN(socket: Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buf = Buffer.alloc(0)

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= n) {
        socket.pause()
        cleanup()
        if (buf.length > n) socket.unshift(buf.subarray(n))
        resolve(buf.subarray(0, n))
      }
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('连接已关闭'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('读取超时'))
    }, timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.resume()
  })
}
