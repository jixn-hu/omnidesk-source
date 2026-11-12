import { checkNativeRuntime, nativeEnvironment, nativeStartupError } from './freerdp-runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { ProxyConfig, RdpOptions, RdpConnection } from '@shared/types.js'
import { requiresLegacyRdp } from './rdp-security.js'
import { canProbeLegacyRdp, type RdpLegacyRetryResult } from '@shared/rdp-security.js'
import { rdpPerformanceOptions } from '@shared/rdp-display.js'
import { FREERDP_MAX_COMMAND, NativePacketDecoder, nativeCommand, nativeFrame, nativeNumbers } from '@shared/freerdp-protocol.js'
import type { RdpCertificateVerifier } from './rdp-certificates.js'
import type { RdpPrepareResult } from './rdp-proxy.js'
import { FreeRdpFiles, NativeFileClipboard, type FileClipboard } from './freerdp-files.js'

interface NativeSession {
  sessionId: string
  token: string
  host: string
  port: number
  options: RdpOptions
  proxy?: ProxyConfig
  credential?: { username: string; password: string; domain: string }
  created: number
  used: boolean
  child?: ChildProcessWithoutNullStreams
  ws?: WebSocket
  controller: AbortController
  error?: string
  expiry?: ReturnType<typeof setTimeout>
  files?: FreeRdpFiles
  connectionFingerprint?: string
  established?: boolean
  fallbackEligible?: boolean
  fallbackRequested?: boolean
  fallbackController?: AbortController
}

function nativeDiagnostic(name: string): string {
  const code = /^[A-Z0-9_]{1,256}$/.test(name) ? name : 'UNKNOWN_NATIVE_ERROR'
  const reason = /DISCONNECTED_BY_OTHER_CONNECTION/.test(code) ? '会话已被其他连接接管，已停止自动重连；手动连接可能中断对方会话' :
    /OMNIDESK_SESSION_RESUME_REJECTED/.test(code) ? '原会话恢复被拒绝，已停止重连；没有使用密码重新登录' :
    /OMNIDESK_SESSION_RESUME_TIMEOUT/.test(code) ? '恢复原会话已超时，已停止自动重连' :
    /RPC_INITIATED_DISCONNECT|RPC_INITIATED_LOGOFF|LOGOFF_BY_USER/.test(code) ? '服务器或用户已结束会话，已停止自动重连' :
    /AUTHENTICATION_FAILED|LOGON_FAILURE|WRONG_PASSWORD|ACCESS_DENIED/.test(code) ? '账号认证失败，请核对用户名、域、密码和远程登录权限' :
    /PASSWORD_EXPIRED|PASSWORD_MUST_CHANGE/.test(code) ? '密码已过期或需要更改，请先通过系统客户端处理' :
    /ACCOUNT_DISABLED|ACCOUNT_LOCKED|ACCOUNT_EXPIRED/.test(code) ? '账号已停用、锁定或过期，请联系服务器管理员' :
    /SECURITY_NEGO/.test(code) ? '服务器拒绝安全协商；若仅支持旧版 RDP 安全层，请在此连接中明确选择旧版模式，或使用系统客户端' :
    /TLS|CERTIFICATE/.test(code) ? 'TLS 握手失败，请检查证书、协议版本和服务器安全策略' :
    /DNS_NAME_NOT_FOUND/.test(code) ? '无法解析服务器地址' :
    /CONNECT_FAILED|CONNECT_TRANSPORT_FAILED/.test(code) ? '连接被拒绝或传输中断，请检查目标端口、代理和服务器日志' :
    /PRE_CONNECT_FAILED|POST_CONNECT_FAILED/.test(code) ? '本机协议通道或图形初始化失败，请检查运行库或切换引擎' : '原生远程桌面会话失败'
  return `${reason}\n${code}`
}

export class FreeRdpService {
  private runtimeProbe?: Promise<void>
  private server?: Server
  private wss?: WebSocketServer
  private starting?: Promise<number>
  private sessions = new Map<string, NativeSession>()
  private disposed = false
  private fileReceiveQueue = Promise.resolve()
  private fileReceiveRevision = 0
  private receivingSession?: string

  constructor(private readonly directory: string, private readonly certificates: RdpCertificateVerifier, private readonly fileClipboard: FileClipboard = new NativeFileClipboard(directory), private readonly fileCacheRoot?: string, private readonly diagnosticRoot?: string) {}

  status(): { available: boolean; version?: string; message: string } {
    if (process.platform !== 'win32' || process.arch !== 'x64') return { available: false, message: 'FreeRDP 当前仅支持 Windows x64' }
    try {
      const manifest = JSON.parse(readFileSync(join(this.directory, 'manifest.json'), 'utf8'))
      if (manifest.protocol !== 6 || manifest.platform !== 'win32-x64' || !manifest.files?.['omnidesk-freerdp.exe'] || !Object.keys(manifest.files).every(name => /^[\w.-]+$/.test(name))) throw new Error('清单协议或文件列表不匹配')
      const missing = Object.keys(manifest.files).filter(name => !existsSync(join(this.directory, name)))
      if (missing.length) throw new Error('缺少 ' + missing.join('、'))
      return { available: true, version: manifest.version, message: `FreeRDP ${manifest.version} · 本机独立进程` }
    } catch (error) { return { available: false, message: `FreeRDP 运行库缺失、过旧或不完整，请重新安装包含运行库的完整安装包${error instanceof Error && /^(缺少 |清单协议)/.test(error.message) ? '（' + error.message + '）' : ''}` } }
  }

  async prepare(host: string, port: number, credential: { username: string; password: string; domain: string }, options: RdpOptions, proxy?: ProxyConfig, connection?: RdpConnection): Promise<RdpPrepareResult> {
    if (this.disposed) throw new Error('FreeRDP 服务已关闭')
    const status = this.status()
    if (!status.available) throw new Error(status.message)
    if (!this.runtimeProbe) this.runtimeProbe = checkNativeRuntime(this.directory).catch(error => { this.runtimeProbe = undefined; throw error })
    await this.runtimeProbe
    if (this.disposed) throw new Error('FreeRDP 服务已关闭')
    if (proxy?.type === 'socks4') throw new Error('FreeRDP 暂不支持 SOCKS4，请改用 SOCKS5 / HTTP 或 IronRDP')
    if (options.securityMode === 'legacy' && options.engine !== 'freerdp') throw new Error('旧版 RDP 安全层仅可用于明确选择的 FreeRDP 连接')
    const listenPort = await this.listen()
    if (this.disposed) throw new Error('FreeRDP 服务已关闭')
    const sessionId = randomUUID()
    const token = randomUUID().replaceAll('-', '')
    const session: NativeSession = { sessionId, token, host, port, credential: { ...credential }, options: { ...options }, proxy: proxy ? { ...proxy } : undefined, created: Date.now(), used: false, controller: new AbortController() }
    session.expiry = setTimeout(() => this.release(sessionId), 60_000)
    session.expiry.unref()
    this.sessions.set(sessionId, session)
    session.connectionFingerprint = connection ? createHash('sha256').update(JSON.stringify(connection)).digest('hex') : undefined
    return { wsUrl: `ws://127.0.0.1:${listenPort}/freerdp/${sessionId}?token=${token}`, sessionId, token }
  }

  async requestLegacyRetry(sessionId: string, connection: RdpConnection, confirm: (signal: AbortSignal) => Promise<boolean>): Promise<RdpLegacyRetryResult> {
    const session = this.sessions.get(sessionId)
    if (!session || session.connectionFingerprint !== createHash('sha256').update(JSON.stringify(connection)).digest('hex') ||
        session.options.securityMode === 'legacy' || session.established || !session.fallbackEligible || session.fallbackRequested || session.fallbackController) return 'unavailable'
    const controller = new AbortController()
    session.fallbackController = controller
    const current = () => this.sessions.get(sessionId) === session
    try {
      const legacy = await requiresLegacyRdp(session.host, session.port, connection.proxy, controller.signal)
      if (!current() || controller.signal.aborted) return 'unavailable'
      if (!legacy) return 'not-required'
      session.fallbackRequested = true
      const accepted = await confirm(controller.signal)
      if (!current() || controller.signal.aborted) return 'unavailable'
      return accepted ? 'accepted' : 'declined'
    } catch (error) {
      if (controller.signal.aborted) return 'unavailable'
      throw error
    } finally {
      controller.abort()
      session.fallbackController = undefined
    }
  }

  getError(sessionId: string): string | null { return this.sessions.get(sessionId)?.error ?? null }
  allowsClipboard(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session?.child && session.options.enableClipboard !== false && !session.controller.signal.aborted
  }

  async clipboardFiles(sessionId: string, action: 'paste' | 'offer' | 'receive' | 'cancel' | 'cancel-paste' | 'sync-text', allowed: () => boolean): Promise<boolean | 'remote'> {
    const session = this.sessions.get(sessionId)
    if (!this.allowsClipboard(sessionId) || !session?.files) throw new Error('请聚焦已开启剪贴板的 FreeRDP 会话后重试')
    if (action === 'cancel-paste') { session.files.cancelPreparation(); return true }
    if (!allowed()) throw new Error('请聚焦已开启剪贴板的 FreeRDP 会话后重试')
    if (action === 'sync-text') return session.files.prepareTextSync(allowed)
    if (action === 'paste') return session.files.publishLocal(allowed)
    if (action === 'offer') { await session.files.offerRemote(); return true }
    if (action === 'receive') {
      if (this.receivingSession && this.receivingSession !== sessionId) this.sessions.get(this.receivingSession)?.files?.cancelDownload()
      this.receivingSession = sessionId
      const revision = ++this.fileReceiveRevision
      const operation = this.fileReceiveQueue.catch(() => {}).then(async () => {
        if (revision === this.fileReceiveRevision && this.allowsClipboard(sessionId) && allowed()) await session.files?.receiveRemote(allowed)
      })
      this.fileReceiveQueue = operation
      await operation
      return true
    }
    if (action === 'cancel') { if (this.receivingSession === sessionId) this.fileReceiveRevision++; session.files.cancel(); return true }
    throw new Error('文件剪贴板操作不正确')
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    if (this.receivingSession === sessionId) { this.fileReceiveRevision++; this.receivingSession = undefined }
    clearTimeout(session.expiry)
    session.controller.abort()
    session.fallbackController?.abort()
    session.files?.dispose()
    session.credential = undefined
    session.proxy = undefined
    session.ws?.terminate()
    session.child?.stdin.destroy()
    session.child?.kill()
  }

  private listen(): Promise<number> {
    if (this.starting) return this.starting
    const address = this.server?.address()
    if (address && typeof address !== 'string') return Promise.resolve(address.port)
    this.starting = (async () => {
      const server = createServer((_request, response) => { response.writeHead(404); response.end() })
      const wss = new WebSocketServer({ noServer: true, maxPayload: FREERDP_MAX_COMMAND, perMessageDeflate: false })
      server.on('upgrade', (request, socket, head) => {
        let url: URL
        try { url = new URL(request.url ?? '/', 'http://127.0.0.1') } catch { socket.destroy(); return }
        const match = /^\/freerdp\/([^/]+)$/.exec(url.pathname)
        const session = match ? this.sessions.get(match[1]) : undefined
        if (!session || session.used || Date.now() - session.created > 60_000 || url.searchParams.get('token') !== session.token) { socket.destroy(); return }
        session.used = true
        wss.handleUpgrade(request, socket, head, ws => this.bind(session, ws))
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
      this.server = server
      this.wss = wss
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('FreeRDP 本机端口分配失败')
      return address.port
    })().finally(() => { this.starting = undefined })
    return this.starting
  }

  private diagnostic(session: NativeSession, event: Record<string, number | string>): void {
    if (!this.diagnosticRoot) return
    try {
      mkdirSync(this.diagnosticRoot, { recursive: true })
      const file = join(this.diagnosticRoot, 'freerdp-diagnostics.jsonl')
      if (existsSync(file) && statSync(file).size >= 1024 * 1024) {
        if (existsSync(file + '.1')) unlinkSync(file + '.1')
        renameSync(file, file + '.1')
      }
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), sessionId: session.sessionId, established: !!session.established, route: session.proxy?.type ?? 'direct', ...event }) + '\n', { mode: 0o600 })
    } catch { /* Diagnostic I/O must not interrupt a desktop. */ }
  }

  private bind(session: NativeSession, ws: WebSocket): void {
    session.ws = ws
    clearTimeout(session.expiry)
    const timer = setTimeout(() => fail('FreeRDP 会话建立超时'), 135_000)
    let ended = false
    let buffered = 0
    const send = (packet: Uint8Array) => {
      if (ws.readyState !== WebSocket.OPEN) return
      buffered += packet.length
      if (buffered > 128 * 1024 * 1024) { fail('FreeRDP 画面传输积压，请使用流畅模式重试'); return }
      if (buffered > 8 * 1024 * 1024) session.child?.stdout.pause()
      ws.send(packet, { binary: true }, error => {
        buffered -= packet.length
        if (error) fail('FreeRDP 本机会话通道已中断')
        else if (buffered < 4 * 1024 * 1024) session.child?.stdout.resume()
      })
    }
    const write = (packet: Uint8Array, sensitive = false) => {
      const input = session.child?.stdin
      if (!input || input.destroyed) return
      const frame = nativeFrame(packet)
      if (sensitive) packet.fill(0)
      if (!input.write(frame, () => { if (sensitive) frame.fill(0) })) { ws.pause(); input.once('drain', () => ws.resume()) }
    }
    const fail = (message: string) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      session.error = message
      send(nativeCommand(3, nativeNumbers(1), new TextEncoder().encode(message)))
      session.controller.abort()
      session.files?.dispose()
      session.credential = undefined
      session.child?.kill()
      ws.close(1011)
    }
    ws.on('message', (raw, binary) => {
      try {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)])
        if (!binary || !data.length || data.length > FREERDP_MAX_COMMAND) throw new Error('无效的本机输入数据')
        if (!session.child) {
          if (data[0] !== 3 || data.length !== 13) throw new Error('FreeRDP 初始化数据不正确')
          const width = data.readUInt32LE(1), height = data.readUInt32LE(5), scale = data.readUInt32LE(9)
          if (width < 200 || height < 200 || width > 8192 || height > 8192 || width % 2 || width * height > 16 * 1024 * 1024 || scale < 100 || scale > 200) throw new Error('FreeRDP 分辨率或缩放超出范围')
          const child = spawn(join(this.directory, 'omnidesk-freerdp.exe'), [], { cwd: this.directory, windowsHide: true, stdio: 'pipe', env: nativeEnvironment(this.directory) })
          session.child = child
          session.files = new FreeRdpFiles(packet => write(packet), this.fileClipboard, status => send(nativeCommand(10, new TextEncoder().encode(JSON.stringify(status)))), this.fileCacheRoot)
          child.on('error', (error: NodeJS.ErrnoException) => fail(nativeStartupError(error.code)))
          child.stdin.on('error', () => { if (!ended) fail('FreeRDP 辅助进程输入通道中断') })
          child.stderr.resume()
          const decoder = new NativePacketDecoder(packet => {
            if (ended) return
            if (packet[0] === 12) {
              if (packet.length !== 21) { fail('FreeRDP 诊断数据格式不正确'); return }
              const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
              this.diagnostic(session, { phase: view.getUint32(1, true), error: view.getUint32(5, true), errorInfo: view.getUint32(9, true), attempt: view.getUint32(13, true), win32Error: view.getUint32(17, true) })
              return
            }
            if (packet[0] === 11 && packet.length === 9 && packet[1] === 1) session.files?.reset()
            if (packet[0] === 9) { session.files?.handle(packet); return }
            if (packet[0] === 6) {
              if (packet.length > 256 * 1024 + 1) { fail('FreeRDP 证书数据超出范围'); return }
              void this.certificates.verifyPem(session.host, session.port, packet.subarray(1), session.controller.signal).then(() => {
                if (!session.controller.signal.aborted) write(nativeCommand(6, nativeNumbers(1)))
              }).catch(error => fail(error instanceof Error ? error.message : 'FreeRDP 证书校验失败'))
              return
            }
            if (packet[0] === 1) { session.established = true; clearTimeout(timer) }
            if (packet[0] === 3) {
              if (packet.length < 5 || packet.length > 265) { fail('FreeRDP 错误数据格式不正确'); return }
              const name = new TextDecoder().decode(packet.subarray(5))
              session.fallbackEligible = canProbeLegacyRdp(name)
              const detail = nativeDiagnostic(name)
              session.error = `FreeRDP：${detail}`
              send(nativeCommand(3, packet.subarray(1, 5), new TextEncoder().encode(detail)))
              return
            }
            send(packet)
            if (packet[0] === 4) { ended = true; clearTimeout(timer); ws.close() }
          })
          child.stdout.on('data', chunk => { try { decoder.push(chunk) } catch { fail('FreeRDP 辅助进程画面数据损坏') } })
          child.on('exit', (code, signal) => { if (!ended) fail(nativeStartupError(code, signal)) })
          write(this.configuration(session, width, height, scale), true)
          session.credential = undefined
          if (session.proxy) session.proxy = { ...session.proxy, password: undefined }
          return
        }
        if (![2, 3, 4, 7].includes(data[0]) || (data[0] === 4 && session.options.enableClipboard === false)) throw new Error('FreeRDP 输入命令不允许')
        if (data[0] === 4 && (session.files?.hasOutgoing || session.files?.hasRemoteFiles)) return
        write(data)
      } catch (error) { fail(error instanceof Error ? error.message : 'FreeRDP 初始化失败') }
    })
    ws.on('error', () => fail('FreeRDP 本机通道错误'))
    ws.on('close', () => {
      clearTimeout(timer)
      session.controller.abort()
      session.files?.dispose()
      session.credential = undefined
      session.child?.kill()
      if (this.sessions.has(session.sessionId)) {
        session.expiry = setTimeout(() => this.release(session.sessionId), 60_000)
        session.expiry.unref()
      }
    })
  }

  private configuration(session: NativeSession, width: number, height: number, scale: number): Uint8Array {
    const options = rdpPerformanceOptions(session.options)
    const credential = session.credential!
    const proxy = session.proxy
    const flags = (options.ignoreCertificate !== false ? 1 : 0) | (options.enableClipboard !== false ? 2 : 0) | (options.securityMode === 'legacy' ? 4 : 0) | (options.dynamicResolution !== false ? 8 : 0)
    let performance = 0
    for (const [enabled, flag] of [[options.showWallpaper, 1], [options.showDraggedWindow, 2], [options.showMenuAnimations, 4], [options.showThemes, 8]] as const) if (!enabled) performance |= flag
    if (options.fontSmoothing) performance |= 0x80
    if (options.desktopComposition) performance |= 0x100
    const encode = (text: string) => { const data = new TextEncoder().encode(text); if (data.length > 65536 || text.includes('\0')) throw new Error('FreeRDP 配置字段超出范围'); return [nativeNumbers(data.length), data] }
    const strings = [session.host, credential.username, credential.password, credential.domain, proxy?.host ?? '', proxy?.username ?? '', proxy?.password ?? '']
    return nativeCommand(1, nativeNumbers(width, height, scale, session.port, flags, options.colorDepth ?? 32, proxy?.type === 'http' ? 1 : proxy?.type === 'socks5' ? 2 : 0, proxy?.port ?? 0, performance), ...strings.flatMap(encode))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const sessionId of this.sessions.keys()) this.release(sessionId)
    await this.fileReceiveQueue.catch(() => {})
    await this.starting
    this.wss?.close()
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()))
    this.server = undefined
  }
}
