import { createServer, type Server } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'
import { connect as connectTls, checkServerIdentity, type DetailedPeerCertificate, type TLSSocket } from 'node:tls'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { ProxyConfig, RdpOptions } from '@shared/types.js'
import { connectViaProxy } from './proxy-connector.js'
import { exchangeX224, parseRdpRequest, rdpAddress, rdpErrorResponse, rdpResponse } from './rdp-protocol.js'
import { RdpCertificateVerifier, rdpCertificateAuthorities } from './rdp-certificates.js'

interface RdpSession {
  sessionId: string
  token: string
  host: string
  port: number
  options: RdpOptions
  proxy?: ProxyConfig
  sockets: Set<{ ws: WebSocket; tcp: Socket | null }>
  createdAt: number
  error?: string
}

export interface RdpPrepareResult {
  wsUrl: string
  sessionId: string
  token: string
}

export class RdpProxyService {
  private httpServer: Server | null = null
  private wss: WebSocketServer | null = null
  private port: number | null = null
  private startPromise: Promise<number> | null = null
  private sessions = new Map<string, RdpSession>()
  private readonly authorities = rdpCertificateAuthorities()

  constructor(private readonly certificateVerifier = new RdpCertificateVerifier()) {}

  async ensureStarted(): Promise<number> {
    if (this.port != null) return this.port
    if (this.startPromise) return await this.startPromise
    this.startPromise = this.createServer()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async createServer(): Promise<number> {
    const server = createServer((_request, response) => {
      response.writeHead(404)
      response.end()
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
    server.on('upgrade', (request, socket, head) => {
      let url: URL
      try { url = new URL(request.url ?? '/', 'http://127.0.0.1') }
      catch { socket.destroy(); return }
      const match = /^\/rdp\/([^/]+)$/.exec(url.pathname)
      const session = match ? this.sessions.get(match[1]) : undefined
      if (!session || session.sockets.size || url.searchParams.get('token') !== session.token ||
          Date.now() - session.createdAt > 30 * 60_000) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.bindSession(ws, session))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('RDP 代理端口分配失败')
    this.httpServer = server
    this.wss = wss
    this.port = address.port
    return address.port
  }

  async prepare(host: string, port: number, options: RdpOptions = {}, proxy?: ProxyConfig): Promise<RdpPrepareResult> {
    this.cleanupIfIdle()
    const proxyPort = await this.ensureStarted()
    const sessionId = randomUUID()
    const token = randomUUID().replace(/-/g, '')
    this.sessions.set(sessionId, { sessionId, token, host, port, options, proxy, sockets: new Set(), createdAt: Date.now() })
    return { wsUrl: `ws://127.0.0.1:${proxyPort}/rdp/${sessionId}?token=${token}`, sessionId, token }
  }

  getError(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.error ?? null
  }

  allowsClipboard(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && session.options.enableClipboard !== false
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    for (const pair of session.sockets) {
      pair.tcp?.destroy()
      pair.ws.terminate()
    }
    session.sockets.clear()
  }

  private bindSession(ws: WebSocket, session: RdpSession): void {
    const pair: { ws: WebSocket; tcp: Socket | null } = { ws, tcp: null }
    session.sockets.add(pair)
    let closed = false
    let requested = false
    let ready = false
    const certificateCheck = new AbortController()
    const timer = setTimeout(() => fail(new Error('RDP 传输握手超时')), 45_000)

    const cleanup = () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      certificateCheck.abort()
      pair.tcp?.destroy()
      session.sockets.delete(pair)
    }
    const fail = (error: unknown) => {
      if (closed) return
      session.error = error instanceof Error ? error.message : String(error)
      if (ws.readyState === WebSocket.OPEN) {
        if (!ready) ws.send(rdpErrorResponse())
        ws.close(1011, 'RDP transport failed')
      }
      cleanup()
    }

    ws.on('error', fail)
    ws.once('close', cleanup)
    ws.on('message', (data: RawData, binary: boolean) => {
      if (closed) return
      if (!binary) return fail(new Error('RDP 传输只接受二进制消息'))
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
      if (ready && pair.tcp) {
        if (!pair.tcp.write(bytes)) ws.pause()
        return
      }
      if (requested) return fail(new Error('RDP 握手完成前收到了额外数据'))
      requested = true
      void (async () => {
        const request = parseRdpRequest(bytes)
        if (request.token !== session.token || request.destination !== rdpAddress(session.host, session.port)) {
          throw new Error('RDP 传输令牌或目标地址不匹配')
        }
        let negotiated: { secure: TLSSocket; x224: Buffer } | undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          const tcp = await this.openTarget(session)
          if (closed) {
            tcp.destroy()
            return
          }
          pair.tcp = tcp
          let secure: TLSSocket | undefined
          try {
            const x224 = await exchangeX224(tcp, request.x224)
            if (closed) return
            secure = connectTls({
              socket: tcp,
              servername: isIP(session.host) ? undefined : session.host,
              rejectUnauthorized: false,
              ca: this.authorities,
              checkServerIdentity: (_hostname, certificate) => checkServerIdentity(session.host, certificate),
              minVersion: 'TLSv1.2',
              ...(attempt === 1 ? {
                maxVersion: 'TLSv1.2' as const,
                ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256'
              } : {})
            })
            pair.tcp = secure
            await this.waitForTls(secure)
            negotiated = { secure, x224 }
            break
          } catch (error) {
            secure?.destroy()
            tcp.destroy()
            if (closed) return
            if (attempt === 0 && (error as NodeJS.ErrnoException)?.code === 'ERR_SSL_KEY_USAGE_BIT_INCORRECT') continue
            if (secure) throw new Error(`RDP TLS 握手 / 传输失败：${error instanceof Error ? error.message : String(error)}`)
            throw error
          }
        }
        if (!negotiated || closed) return
        const { secure, x224 } = negotiated
        secure.on('error', (error: Error) => fail(new Error(`RDP TLS 握手 / 传输失败：${error.message}`)))
        secure.once('close', () => {
          if (!ready) return fail(new Error('RDP TLS 安全通道在服务器身份确认完成前已关闭'))
          cleanup()
          if (ws.readyState === WebSocket.OPEN) ws.close(1000)
        })
        clearTimeout(timer)
        if (session.options.ignoreCertificate === false) {
          await this.certificateVerifier.verify(session.host, session.port, secure, certificateCheck.signal)
        }
        if (closed) return
        const certificates = this.certificates(secure)
        if (!certificates.length) throw new Error('RDP 服务器没有提供 TLS 证书')
        const address = rdpAddress(secure.remoteAddress ?? session.host, secure.remotePort ?? session.port)
        ws.send(rdpResponse(address, x224, certificates))
        ready = true
        clearTimeout(timer)
        secure.on('drain', () => { if (!closed) ws.resume() })
        secure.on('data', (chunk: Buffer) => {
          if (ws.readyState !== WebSocket.OPEN) return
          if (ws.bufferedAmount > 8 * 1024 * 1024) secure.pause()
          ws.send(chunk, (error) => {
            if (error) fail(error)
            else if (!closed && ws.bufferedAmount < 1024 * 1024) secure.resume()
          })
        })
        secure.resume()
      })().catch(fail)
    })
  }

  private waitForTls(socket: TLSSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.off('secureConnect', onSecure)
        socket.off('error', onError)
        socket.off('close', onClose)
      }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const onSecure = () => { cleanup(); resolve() }
      const onClose = () => onError(new Error('TLS 安全通道已关闭'))
      socket.once('secureConnect', onSecure)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
  }

  private async openTarget(session: RdpSession): Promise<Socket> {
    if (session.proxy && session.proxy.type !== 'none') {
      return await connectViaProxy(session.proxy, { host: session.host, port: session.port })
    }
    return await new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: session.host, port: session.port })
      const timer = setTimeout(() => socket.destroy(new Error('RDP TCP 连接超时')), 15_000)
      socket.once('error', reject)
      socket.once('close', () => clearTimeout(timer))
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.off('error', reject)
        socket.setNoDelay(true)
        resolve(socket)
      })
    })
  }

  private certificates(socket: TLSSocket): Buffer[] {
    const result: Buffer[] = []
    const seen = new Set<string>()
    let certificate: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true)
    while (certificate?.raw && result.length < 16) {
      const key = certificate.raw.toString('base64')
      if (seen.has(key)) break
      seen.add(key)
      result.push(certificate.raw)
      certificate = certificate.issuerCertificate
    }
    return result
  }

  getStatus(): { running: boolean; port: number | null; activeSessions: number; activeConnections: number } {
    return { running: this.port != null, port: this.port, activeSessions: this.sessions.size,
      activeConnections: [...this.sessions.values()].reduce((count, session) => count + session.sockets.size, 0) }
  }

  getSessionStats(): Array<{ sessionId: string; host: string; port: number; connections: number; createdAt: number }> {
    return [...this.sessions.values()].map((session) => ({ sessionId: session.sessionId, host: session.host,
      port: session.port, connections: session.sockets.size, createdAt: session.createdAt }))
  }

  private cleanupIfIdle(): void {
    for (const [id, session] of this.sessions) {
      if (!session.sockets.size && Date.now() - session.createdAt > 30 * 60_000) this.sessions.delete(id)
    }
  }

  async dispose(): Promise<void> {
    for (const id of this.sessions.keys()) this.release(id)
    await new Promise<void>((resolve) => this.wss ? this.wss.close(() => resolve()) : resolve())
    await new Promise<void>((resolve) => this.httpServer ? this.httpServer.close(() => resolve()) : resolve())
    this.httpServer = null
    this.wss = null
    this.port = null
  }
}
