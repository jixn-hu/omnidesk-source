/**
 * SSH 会话服务
 *
 * 职责：
 *   - 管理 SSH 会话池（一个会话 = 一条连接）
 *   - 提供三种使用形态：交互式 shell（给终端用）、单次 exec（给 AI / API 用）、SFTP（给文件管理用）
 *   - 主机密钥校验（TOFU：首次信任，之后必须匹配）
 *
 * 设计要点：界面的终端和 AI 的 exec 走的是同一个会话池，
 * 所以 AI 看到的服务器状态和用户在终端里看到的必然一致。
 */
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Socket } from 'node:net'
import type { ExecOptions, ExecResult, SessionInfo, SshConnection } from '@shared/types.js'
import { EXEC_LIMITS } from '@shared/constants.js'
import { parseConnectionAddress } from '@shared/connection-identity.js'
import { connectViaProxy, connectDirect, ProxyError } from './proxy-connector.js'

interface Session {
  info: SessionInfo
  client: Client
  /** 交互式 shell 通道（终端用） */
  shell?: ClientChannel
  /** 最近一次终端尺寸，重连时恢复 */
  termSize?: { cols: number; rows: number }
  connection: SshConnection
}

/** 主机密钥决策结果 */
export interface HostKeyDecision {
  accept: boolean
  /** true = 记住这个指纹，之后不再询问 */
  remember: boolean
}

export interface SshServiceEvents {
  /** shell 输出 */
  data: (sessionId: string, chunk: Buffer) => void
  /** shell 关闭 */
  close: (sessionId: string, reason?: string) => void
  /** 需要用户确认主机密钥 */
  hostKeyPrompt: (payload: {
    sessionId: string
    host: string
    port: number
    fingerprint: string
    keyType: string
    /** 与之前记录的不一致时为 true —— 可能是中间人攻击 */
    changed: boolean
    previousFingerprint?: string
  }) => void
  /** 会话状态变化 */
  sessionEvent: (info: SessionInfo) => void
}

export class SshService extends EventEmitter {
  private sessions = new Map<string, Session>()
  /** host:port -> 已信任的主机密钥指纹 */
  private knownHosts = new Map<string, string>()
  /** 等待用户决策的主机密钥 */
  private pendingHostKeys = new Map<string, (d: HostKeyDecision) => void>()

  /** 由依赖注入设置：解析连接的凭据 */
  constructor(
    /**
     * 凭据解析器。入参是整条连接而不仅是 credentialRef ——
     * 因为还要考虑「该连接是否引用了公共凭据」。
     */
    private resolveCredential: (
      conn: SshConnection
    ) => { secret: string; passphrase?: string; username?: string } | null,
    private loadKnownHosts: () => Record<string, string>,
    private saveKnownHosts: (hosts: Record<string, string>) => void
  ) {
    super()
    const saved = this.loadKnownHosts()
    for (const [k, v] of Object.entries(saved)) this.knownHosts.set(k, v)
  }

  /* ---------------------------------------------------------------- */
  /* 主机密钥                                                          */
  /* ---------------------------------------------------------------- */

  private hostKeyId(host: string, port: number, keyType: string): string {
    return `${host}:${port}:${keyType}`
  }

  static fingerprint(key: Buffer): string {
    // 与 OpenSSH 一致的 SHA256 指纹表示
    const hash = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
    return 'SHA256:' + hash
  }

  /**
   * 校验主机密钥。
   * 首次见到该主机 → 交给用户决定（TOFU）；已记录且一致 → 通过；
   * 已记录但不一致 → 标记 changed，要求用户显式确认（可能是中间人）。
   */
  private async verifyHostKey(
    sessionId: string,
    host: string,
    port: number,
    keyType: string,
    key: Buffer
  ): Promise<boolean> {
    const id = this.hostKeyId(host, port, keyType)
    const fp = SshService.fingerprint(key)
    const known = this.knownHosts.get(id)

    if (known === fp) return true

    const decision = await new Promise<HostKeyDecision>((resolve) => {
      this.pendingHostKeys.set(sessionId, resolve)
      this.emit('hostKeyPrompt', {
        sessionId,
        host,
        port,
        fingerprint: fp,
        keyType,
        changed: Boolean(known),
        previousFingerprint: known
      })
    })

    if (!decision.accept) return false

    if (decision.remember) {
      this.knownHosts.set(id, fp)
      const obj: Record<string, string> = {}
      for (const [k, v] of this.knownHosts) obj[k] = v
      this.saveKnownHosts(obj)
    }
    return true
  }

  /** 界面回传用户对主机密钥的决策 */
  resolveHostKey(sessionId: string, decision: HostKeyDecision): void {
    const pending = this.pendingHostKeys.get(sessionId)
    if (pending) {
      this.pendingHostKeys.delete(sessionId)
      pending(decision)
    }
  }

  /** 清除某主机已记录的指纹 */
  forgetHost(host: string, port: number): void {
    for (const key of [...this.knownHosts.keys()]) {
      if (key.startsWith(`${host}:${port}:`)) this.knownHosts.delete(key)
    }
    const obj: Record<string, string> = {}
    for (const [k, v] of this.knownHosts) obj[k] = v
    this.saveKnownHosts(obj)
  }

  /* ---------------------------------------------------------------- */
  /* 建立连接                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 连接前的凭据体检。
   *
   * 为什么要在连之前查：ssh2 在所有认证方式都失败时只会给一句
   * 「All configured authentication methods failed」——
   * 这句话对用户毫无帮助，因为「没存密码」和「密码错了」是同一句报错。
   * 提前查一次，就能把这两种情况分开，各给各的提示。
   */
  private checkCredential(connection: SshConnection): { secret: string; passphrase?: string } | null {
    if (connection.authMethod === 'agent') return null // Agent 模式不需要凭据

    const sharedId = (connection as { sharedCredentialId?: string }).sharedCredentialId
    const what = connection.authMethod === 'privateKey' ? '私钥' : '密码'

    // 引用了公共凭据时，凭据内容不在连接上，这里只做「能否读到」的检查
    if (sharedId) {
      const cred = this.resolveCredential(connection)
      if (!cred || !cred.secret) {
        throw new Error(
          `该连接引用的公共凭据读取不到。\n\n` +
            `可能是：公共凭据已被删除，或凭据保险箱处于锁定状态。\n` +
            `请在「设置 → 公共凭据」中确认它仍然存在且内容完整。`
        )
      }
      return cred
    }

    if (!connection.credentialRef) {
      throw new Error(
        `该连接还没有保存${what}。\n\n` +
          `请右键该连接 → 编辑，在「${what}」一栏填入后保存，再重新连接。\n` +
          `如果多台机器共用同一个${what}，可以在「设置 → 公共凭据」里建一条共享凭据，` +
          `然后在连接里选它 —— 以后改一处就能全部生效。`
      )
    }

    const cred = this.resolveCredential(connection)
    if (!cred || !cred.secret) {
      // resolveCredential 在保险箱锁定时会返回 null —— 这是最常见的原因
      throw new Error(
        `无法读取该连接的凭据。\n\n` +
          `最可能的原因：凭据保险箱处于锁定状态。\n` +
          `如果使用的是主密码模式，请先在「设置 → 凭据保护」里解锁；` +
          `或直接把该连接重新编辑保存一次以重置凭据。`
      )
    }

    return cred
  }

  /** 把 ssh2 的错误翻译成用户能照着做的提示 */
  private describeAuthError(raw: string, connection: SshConnection): string {
    const lower = raw.toLowerCase()

    if (lower.includes('all configured authentication methods failed')) {
      const what = connection.authMethod === 'privateKey' ? '私钥' : '密码'
      const extra =
        connection.authMethod === 'privateKey'
          ? `· 私钥格式是否正确（支持 OpenSSH / PEM）\n` +
            `· 私钥是否设置了口令，若有需一并填写\n` +
            `· 目标机的 ~/.ssh/authorized_keys 是否已加入对应公钥`
          : `· 用户名是否正确（注意 root 与普通用户的区别）\n` +
            `· 密码是否正确（密码里若有特殊字符，确认没有多余空格）`
      return (
        `认证失败 —— 目标机拒绝了所有认证方式。\n\n` +
        `请检查：\n${extra}\n` +
        `· 目标机是否允许${what}登录（sshd_config 里的 PasswordAuthentication / PubkeyAuthentication）`
      )
    }

    if (lower.includes('etimedout') || lower.includes('timed out')) {
      return (
        `连接 ${connection.host}:${connection.port} 超时。\n\n` +
          `目标无响应，通常是网络不通或被防火墙静默丢弃。`
      )
    }
    if (lower.includes('econnrefused') || lower.includes('econnreset')) {
      return (
        `无法连接到 ${connection.host}:${connection.port} —— 目标拒绝连接。\n\n` +
          `请确认 SSH 服务已启动、端口正确、防火墙放行。`
      )
    }
    if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
      return `无法解析主机名 ${connection.host}。请检查拼写，或改用 IP 地址。`
    }
    if (lower.includes('host key verification failed') || lower.includes('hostverifier')) {
      return (
        `主机密钥校验未通过。\n\n` +
          `如果你确认目标机没问题（例如刚重装过系统），重新连接时会再次弹出指纹确认。`
      )
    }
    if (lower.includes('no matching') && lower.includes('key exchange')) {
      return (
        `与目标机没有共同支持的密钥交换算法。\n\n` +
          `目标机可能使用了过旧的 SSH 版本（如老旧的 OpenSSH 5.x）。`
      )
    }

    return raw
  }

  private buildConnectConfig(connection: SshConnection, sessionId: string): ConnectConfig {
    const cred = this.resolveCredential(connection)

    const config: ConnectConfig = {
      host: connection.host,
      port: connection.port,
      username: cred?.username || connection.username,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
        void this.verifyHostKey(sessionId, connection.host, connection.port, 'ssh', key)
          .then(verify, () => verify(false))
      }
    }

    switch (connection.authMethod) {
      case 'password':
        config.password = cred?.secret ?? ''
        break
      case 'privateKey':
        config.privateKey = cred?.secret ?? ''
        if (cred?.passphrase) config.passphrase = cred.passphrase
        break
      case 'agent':
        if (process.platform === 'win32') {
          // Windows 上 ssh2 通过 named pipe 访问 OpenSSH agent
          config.agent = '\\\\.\\pipe\\openssh-ssh-agent'
        } else {
          config.agent = process.env['SSH_AUTH_SOCK'] ?? ''
        }
        break
    }

    return config
  }

  /**
   * 若该连接配置了代理，先经代理建立一条到目标的 socket，
   * 再把它交给 ssh2 使用 —— 这样 ssh2 本身不需要知道代理的存在。
   * 未配置代理时返回 undefined，ssh2 会自己直连。
   */
  private async openTransport(connection: SshConnection): Promise<Socket | undefined> {
    const proxy = connection.proxy
    if (!proxy || proxy.type === 'none' || !proxy.host) return undefined

    try {
      return await connectViaProxy(proxy, { host: connection.host, port: connection.port })
    } catch (err) {
      if (err instanceof ProxyError) {
        throw new Error(`[${err.stage}] ${err.message}`)
      }
      throw err
    }
  }

  /** 建立一条会话（不自动开 shell） */
  async connect(connection: SshConnection, ownerId?: string): Promise<SessionInfo> {
    connection = { ...connection, ...parseConnectionAddress(connection.host, connection.port) }
    const sessionId = randomUUID()
    const info: SessionInfo = {
      id: sessionId,
      ownerId,
      connectionId: connection.id,
      kind: 'ssh',
      name: connection.name,
      status: 'connecting',
      startedAt: Date.now()
    }
    this.emit('sessionEvent', info)

    const client = new Client()
    const session: Session = { info, client, connection }
    this.sessions.set(sessionId, session)

    // 凭据体检：在连之前就把「没密码」「保险箱锁了」这类问题挑出来，
    // 否则它们都会表现为 ssh2 那句无用的「所有认证方式都失败」
    try {
      this.checkCredential(connection)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      info.status = 'error'
      info.lastError = msg
      this.emit('sessionEvent', info)
      this.sessions.delete(sessionId)
      throw new Error(msg)
    }

    // 有代理时先打通代理链路，失败就不必再启动 ssh2 了
    let transport: Socket | undefined
    try {
      transport = await this.openTransport(connection)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      info.status = 'error'
      info.lastError = msg
      this.emit('sessionEvent', info)
      this.sessions.delete(sessionId)
      throw new Error(msg)
    }

    if (!this.sessions.has(sessionId)) {
      transport?.destroy()
      throw new Error('SSH 连接已取消')
    }

    return await new Promise<SessionInfo>((resolve, reject) => {
      const fail = (msg: string) => {
        this.resolveHostKey(sessionId, { accept: false, remember: false })
        info.status = 'error'
        info.lastError = msg
        this.emit('sessionEvent', info)
        this.sessions.delete(sessionId)
        try {
          transport?.destroy()
        } catch {
          /* ignore */
        }
        reject(new Error(msg))
      }

      client.on('ready', () => {
        client.setNoDelay(true)
        info.status = 'connected'
        info.lastError = undefined
        this.emit('sessionEvent', info)
        resolve(info)
      })

      client.on('error', (err) => {
        fail(this.describeAuthError(err.message, connection))
      })

      client.on('close', () => {
        reject(new Error('SSH 连接已关闭或取消'))
        this.resolveHostKey(sessionId, { accept: false, remember: false })
        info.status = 'disconnected'
        this.emit('sessionEvent', info)
        this.emit('close', sessionId)
        this.sessions.delete(sessionId)
      })

      try {
        const config = this.buildConnectConfig(connection, sessionId)
        info.username = config.username
        // 把代理打通的 socket 交给 ssh2；未配置代理时为 undefined，ssh2 自行直连
        if (transport) config.sock = transport
        client.connect(config)
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })
  }

  /* ---------------------------------------------------------------- */
  /* 交互式 shell                                                      */
  /* ---------------------------------------------------------------- */

  /** 打开交互式 shell，输出通过 data 事件推给渲染进程 */
  async openShell(sessionId: string, cols = 80, rows = 24): Promise<void> {
    const session = this.requireSession(sessionId)
    if (session.shell) return

    session.termSize = { cols, rows }

    await new Promise<void>((resolve, reject) => {
      session.client.shell(
        {
          term: 'xterm-256color',
          cols,
          rows,
          width: 0,
          height: 0
        },
        (err, stream) => {
          if (err) return reject(err)
          session.shell = stream
          stream.on('data', (chunk: Buffer) => {
            this.emit('data', sessionId, chunk)
          })
          stream.stderr.on('data', (chunk: Buffer) => {
            this.emit('data', sessionId, chunk)
          })
          stream.on('close', () => {
            if (session.shell === stream) session.shell = undefined
            this.emit('close', sessionId)
          })
          resolve()
        }
      )
    })
  }

  write(sessionId: string, data: string | Buffer): void {
    const session = this.requireSession(sessionId)
    session.shell?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.requireSession(sessionId)
    session.termSize = { cols, rows }
    session.shell?.setWindow(rows, cols, 0, 0)
  }

  /* ---------------------------------------------------------------- */
  /* 单次执行 —— AI 与 HTTP API 的主入口                                */
  /* ---------------------------------------------------------------- */

  /**
   * 执行一条命令并收集输出。
   * 与交互式 shell 用同一条连接，所以环境变量、工作目录等状态共享。
   */
  async exec(sessionId: string, command: string, opts: ExecOptions & { stdin?: string } = {}): Promise<ExecResult> {
    const session = this.requireSession(sessionId)
    const started = Date.now()
    const timeoutMs = opts.timeoutMs ?? EXEC_LIMITS.timeoutMs
    const maxBytes = opts.maxBytes ?? EXEC_LIMITS.maxBytes
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('命令超时与输出上限必须为正整数')
    }

    let finalCommand = command
    if (opts.cwd) {
      finalCommand = `cd ${shellQuote(opts.cwd)} && ${finalCommand}`
    }
    if (opts.sudo) {
      finalCommand = await this.wrapSudo(finalCommand, opts)
    }

    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let channel: ClientChannel | undefined
      let exitCode: number | null = null
      let exitSignal: string | undefined

      const finish = (code: number | null, signal?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          code,
          signal,
          durationMs: Date.now() - started,
          truncated
        })
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        channel?.close()
        channel?.destroy()
        reject(new Error(`命令执行超时（${timeoutMs}ms）`))
      }, timeoutMs)

      session.client.exec(finalCommand, { pty: false }, (err, stream) => {
        if (err) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(err)
          }
          return
        }
        channel = stream
        if (settled) {
          stream.close()
          stream.destroy()
          return
        }

        stream.on('data', (chunk: Buffer) => {
          const remaining = Math.max(0, maxBytes - stdoutBytes)
          if (chunk.length > remaining) truncated = true
          if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining))
          stdoutBytes += Math.min(chunk.length, remaining)
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          const remaining = Math.max(0, maxBytes - stderrBytes)
          if (chunk.length > remaining) truncated = true
          if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining))
          stderrBytes += Math.min(chunk.length, remaining)
        })
        stream.on('exit', (code: number | null, signal?: string) => {
          exitCode = typeof code === 'number' ? code : null
          exitSignal = signal
        })
        stream.on('close', (code: number | null) => {
          finish(exitCode ?? (typeof code === 'number' ? code : null), exitSignal)
        })
        stream.on('error', (error: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        })
        // Send ephemeral input on the encrypted channel, never in command arguments.
        if (opts.stdin !== undefined) stream.end(opts.stdin)
      })
    })
  }

  /**
   * sudo 包装。
   *
   * 不用 `echo pass | sudo -S` —— 那样密码会出现在进程列表里。
   * 改用 sudo 的 askpass 机制：临时写一个只回显密码的脚本，用 SUDO_ASKPASS 指过去。
   */
  private async wrapSudo(command: string, opts: ExecOptions): Promise<string> {
    if (!opts.sudoPassword) {
      // 无密码 sudo（NOPASSWD 配置）
      return `sudo -n ${command}`
    }
    // 密码经 stdin 传给 sh，再用 askpass 脚本回显，避免出现在 ps 输出中
    const pw = opts.sudoPassword
    const script = [
      'ASKPASS=$(mktemp)',
      `printf '#!/bin/sh\\nprintf %s ${shellQuote(pw)}\\n' > "$ASKPASS"`,
      'chmod 700 "$ASKPASS"',
      `SUDO_ASKPASS="$ASKPASS" sudo -A ${command}`,
      '__rc=$?',
      'rm -f "$ASKPASS"',
      'exit $__rc'
    ].join('; ')
    return script
  }

  /* ---------------------------------------------------------------- */
  /* 会话管理                                                          */
  /* ---------------------------------------------------------------- */

  private requireSession(sessionId: string): Session {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('会话不存在或已断开')
    return s
  }

  getClient(sessionId: string): Client {
    return this.requireSession(sessionId).client
  }

  getConnection(sessionId: string): SshConnection {
    return this.requireSession(sessionId).connection
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  /** 通过连接 id 找到已建立的会话（供外部 API 复用） */
  findByConnectionId(connectionId: string): string | null {
    for (const [id, s] of this.sessions) {
      if (s.connection.id === connectionId && s.info.status === 'connected') return id
    }
    return null
  }

  disconnect(sessionId: string): void {
    this.resolveHostKey(sessionId, { accept: false, remember: false })
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.shell?.end()
      s.client.end()
    } finally {
      s.info.status = 'disconnected'
      this.emit('sessionEvent', s.info)
      this.sessions.delete(sessionId)
    }
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }
}

/** POSIX shell 单引号转义 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
