/**
 * 代理连接器
 *
 * 支持 SOCKS5 / SOCKS4 / HTTP CONNECT 三种代理，用于让「某一条连接」
 * 的流量从指定出口出去。这是按连接粒度的配置 —— 不影响其他连接。
 *
 * 为什么自己实现而不引库：
 *   SOCKS5 握手只有几十行，HTTP CONNECT 更是一行请求头的事。
 *   自己写的收益是：完全可控（超时、错误信息、认证方式），
 *   而且避免为一个简单功能引入一串传递依赖。
 *
 * 典型用法：
 *   国内机器 A ←这里不开代理→ 直连
 *   海外机器 B ←走公司代理→  出口在代理侧
 *   两台机器各自的配置互不影响
 */
import { Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { createConnection } from 'node:net'
import type { ProxyConfig } from '@shared/types.js'

export type ProxySocket = Socket | TLSSocket

/** 连接目标：主机 + 端口 */
export interface ProxyTarget {
  host: string
  port: number
}

/** 代理连接失败时抛出，带上足够定位问题的上下文 */
export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly stage: 'connect' | 'handshake' | 'auth' | 'reply',
    public readonly proxy?: string
  ) {
    super(message)
    this.name = 'ProxyError'
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 通过代理建立到目标的 TCP 连接。
 * 返回一个已连通的 socket，可直接交给 ssh2 / RDP 代理使用。
 */
export async function connectViaProxy(
  proxy: ProxyConfig,
  target: ProxyTarget,
  timeoutMs = 20_000
): Promise<ProxySocket> {
  switch (proxy.type) {
    case 'socks5':
      return await connectSocks5(proxy, target, timeoutMs)
    case 'socks4':
      return await connectSocks4(proxy, target, timeoutMs)
    case 'http':
      return await connectHttp(proxy, target, timeoutMs)
    default:
      throw new ProxyError(`不支持的代理类型：${(proxy as { type: string }).type}`, 'connect')
  }
}

/** 直连（无代理），保持接口一致便于调用方统一处理 */
export async function connectDirect(target: ProxyTarget, timeoutMs = 20_000): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: target.host, port: target.port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 ${target.host}:${target.port} 超时（${timeoutMs}ms）`))
    }, timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    })
  })
}

/* ------------------------------------------------------------------ */
/* SOCKS5 (RFC 1928 + RFC 1929 用户名密码认证)                         */
/* ------------------------------------------------------------------ */

const SOCKS5_VERSION = 0x05
const AUTH_NONE = 0x00
const AUTH_USERPASS = 0x02
const AUTH_NO_ACCEPTABLE = 0xff
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

const SOCKS5_REPLY_TEXT: Record<number, string> = {
  0x01: '代理服务器内部错误',
  0x02: '代理规则不允许该连接',
  0x03: '网络不可达',
  0x04: '主机不可达',
  0x05: '目标拒绝连接',
  0x06: 'TTL 超时',
  0x07: '不支持的指令',
  0x08: '不支持的地址类型'
}

async function connectSocks5(
  proxy: ProxyConfig,
  target: ProxyTarget,
  timeoutMs: number
): Promise<Socket> {
  const label = `${proxy.host}:${proxy.port}`
  const socket = await openProxySocket(proxy, timeoutMs, label)

  try {
    const useAuth = Boolean(proxy.username)

    // --- ① 问候：声明支持的认证方式 ---
    const methods = useAuth ? [AUTH_USERPASS] : [AUTH_NONE]
    socket.write(Buffer.from([SOCKS5_VERSION, methods.length, ...methods]))

    const greeting = await readExactly(socket, 2, timeoutMs)
    if (greeting[0] !== SOCKS5_VERSION) {
      throw new ProxyError(`代理返回了非 SOCKS5 响应（版本 ${greeting[0]}）`, 'handshake', label)
    }

    if (greeting[1] === AUTH_NO_ACCEPTABLE) {
      throw new ProxyError('代理拒绝了所有可用的认证方式', 'auth', label)
    }
    if (greeting[1] === AUTH_USERPASS) {
      if (!useAuth) {
        throw new ProxyError('代理要求用户名密码认证，但未配置凭据', 'auth', label)
      }
      await socks5UserPassAuth(socket, proxy, timeoutMs, label)
    } else if (greeting[1] !== AUTH_NONE) {
      throw new ProxyError(`代理选择了不支持的认证方式：${greeting[1]}`, 'auth', label)
    }

    // --- ② 请求连接目标 ---
    const request = buildSocks5Request(target)
    socket.write(request)

    // --- ③ 读回复：版本 + 状态码 + 保留位 + 地址类型 ---
    const head = await readExactly(socket, 4, timeoutMs)
    if (head[1] !== 0x00) {
      const text = SOCKS5_REPLY_TEXT[head[1]] ?? `未知错误码 0x${head[1].toString(16)}`
      throw new ProxyError(`代理拒绝连接：${text}`, 'reply', label)
    }

    // 跳过绑定地址（长度取决于类型）
    const atyp = head[3]
    if (atyp === ATYP_IPV4) await readExactly(socket, 4 + 2, timeoutMs)
    else if (atyp === ATYP_IPV6) await readExactly(socket, 16 + 2, timeoutMs)
    else if (atyp === ATYP_DOMAIN) {
      const len = (await readExactly(socket, 1, timeoutMs))[0]!
      await readExactly(socket, len + 2, timeoutMs)
    }

    socket.removeAllListeners('error')
    return socket
  } catch (err) {
    socket.destroy()
    throw err instanceof ProxyError ? err : new ProxyError(String(err), 'handshake', label)
  }
}

function buildSocks5Request(target: ProxyTarget): Buffer {
  const host = target.host
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)

  const head = Buffer.from([SOCKS5_VERSION, CMD_CONNECT, 0x00])
  let addr: Buffer

  if (ipv4) {
    addr = Buffer.from([ATYP_IPV4, ...ipv4.slice(1).map(Number)])
  } else if (host.includes(':')) {
    // 粗略判断 IPv6
    const parts = parseIpv6(host)
    if (parts) {
      addr = Buffer.concat([Buffer.from([ATYP_IPV6]), parts])
    } else {
      addr = domainBuffer(host)
    }
  } else {
    addr = domainBuffer(host)
  }

  const port = Buffer.alloc(2)
  port.writeUInt16BE(target.port)
  return Buffer.concat([head, addr, port])
}

function domainBuffer(host: string): Buffer {
  const bytes = Buffer.from(host, 'utf8')
  if (bytes.length > 255) throw new ProxyError('目标主机名过长', 'handshake')
  return Buffer.concat([Buffer.from([ATYP_DOMAIN, bytes.length]), bytes])
}

async function socks5UserPassAuth(
  socket: Socket,
  proxy: ProxyConfig,
  timeoutMs: number,
  label: string
): Promise<void> {
  const user = Buffer.from(proxy.username ?? '', 'utf8')
  const pass = Buffer.from(proxy.password ?? '', 'utf8')
  if (user.length > 255 || pass.length > 255) {
    throw new ProxyError('代理用户名或密码过长', 'auth', label)
  }

  const packet = Buffer.concat([
    Buffer.from([0x01, user.length]),
    user,
    Buffer.from([pass.length]),
    pass
  ])
  socket.write(packet)

  const reply = await readExactly(socket, 2, timeoutMs)
  if (reply[1] !== 0x00) {
    throw new ProxyError('代理认证失败（用户名或密码错误）', 'auth', label)
  }
}

/* ------------------------------------------------------------------ */
/* SOCKS4 (含 4a：域名走 0.0.0.x)                                      */
/* ------------------------------------------------------------------ */

const SOCKS4_REPLY_TEXT: Record<number, string> = {
  0x5b: '请求被拒绝或失败',
  0x5c: '无法连接到 identd',
  0x5d: 'identd 无法确认用户 ID'
}

async function connectSocks4(
  proxy: ProxyConfig,
  target: ProxyTarget,
  timeoutMs: number
): Promise<Socket> {
  const label = `${proxy.host}:${proxy.port}`
  const socket = await openProxySocket(proxy, timeoutMs, label)

  try {
    const userId = Buffer.from(proxy.username ?? '', 'utf8')
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(target.host)

    let ipBytes: Buffer
    let tail: Buffer

    if (ipv4) {
      ipBytes = Buffer.from(ipv4.slice(1).map(Number))
      tail = Buffer.alloc(0)
    } else {
      // SOCKS4a：IP 用 0.0.0.1 占位，域名跟在 userid 之后
      ipBytes = Buffer.from([0, 0, 0, 1])
      tail = Buffer.concat([Buffer.from(target.host, 'utf8'), Buffer.from([0x00])])
    }

    const port = Buffer.alloc(2)
    port.writeUInt16BE(target.port)

    socket.write(
      Buffer.concat([Buffer.from([0x04, 0x01]), port, ipBytes, userId, Buffer.from([0x00]), tail])
    )

    const reply = await readExactly(socket, 8, timeoutMs)
    if (reply[1] !== 0x5a) {
      const text = SOCKS4_REPLY_TEXT[reply[1]] ?? `错误码 0x${reply[1].toString(16)}`
      throw new ProxyError(`代理拒绝连接：${text}`, 'reply', label)
    }

    socket.removeAllListeners('error')
    return socket
  } catch (err) {
    socket.destroy()
    throw err instanceof ProxyError ? err : new ProxyError(String(err), 'handshake', label)
  }
}

/* ------------------------------------------------------------------ */
/* HTTP CONNECT                                                        */
/* ------------------------------------------------------------------ */

async function connectHttp(
  proxy: ProxyConfig,
  target: ProxyTarget,
  timeoutMs: number
): Promise<Socket> {
  const label = `${proxy.host}:${proxy.port}`
  const socket = await openProxySocket(proxy, timeoutMs, label)

  try {
    const hostHeader = target.host.includes(':') ? `[${target.host}]` : target.host
    const lines = [
      `CONNECT ${hostHeader}:${target.port} HTTP/1.1`,
      `Host: ${hostHeader}:${target.port}`,
      'Proxy-Connection: Keep-Alive'
    ]

    if (proxy.username) {
      const token = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`, 'utf8').toString('base64')
      lines.push(`Proxy-Authorization: Basic ${token}`)
    }

    socket.write(lines.join('\r\n') + '\r\n\r\n')

    // 读到 \r\n\r\n 为止（代理可能先回 100 Continue 再回 200）
    const header = await readUntilHeadersEnd(socket, timeoutMs)

    const statusLine = header.split('\r\n')[0] ?? ''
    const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine)
    if (!m) {
      throw new ProxyError(`代理返回了无法解析的响应：${statusLine.slice(0, 80)}`, 'reply', label)
    }

    const code = Number(m[1])
    if (code === 407) {
      throw new ProxyError('代理要求认证（407），请检查用户名密码', 'auth', label)
    }
    if (code < 200 || code >= 300) {
      throw new ProxyError(`代理拒绝连接（HTTP ${code}）`, 'reply', label)
    }

    socket.removeAllListeners('error')
    return socket
  } catch (err) {
    socket.destroy()
    throw err instanceof ProxyError ? err : new ProxyError(String(err), 'handshake', label)
  }
}

/* ------------------------------------------------------------------ */
/* 底层工具                                                            */
/* ------------------------------------------------------------------ */

/** 连到代理本身。注意：这一步是直连，不递归走代理 */
async function openProxySocket(
  proxy: ProxyConfig,
  timeoutMs: number,
  label: string
): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: proxy.host, port: proxy.port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new ProxyError(`连接代理 ${label} 超时`, 'connect', label))
    }, timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      // 握手期间保留错误监听，但避免未处理异常导致进程退出
      socket.on('error', () => {
        /* 由上层 catch 处理 */
      })
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new ProxyError(`无法连接代理 ${label}：${err.message}`, 'connect', label))
    })
  })
}

/** 精确读取 n 字节（不足则等，超时则抛） */
function readExactly(socket: Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let got = 0

    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      got += chunk.length
      if (got >= n) {
        cleanup()
        const all = Buffer.concat(chunks)
        // 多读的部分塞回流（代理可能把目标数据一起发过来）
        if (all.length > n) socket.unshift(all.subarray(n))
        resolve(all.subarray(0, n))
      }
    }

    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new ProxyError('代理在握手过程中断开连接', 'handshake'))
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new ProxyError(`代理握手超时（等待 ${n} 字节，已收到 ${got}）`, 'handshake'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

/** 读取 HTTP 响应头（到空行为止），返回头文本与可能的剩余数据 */
function readUntilHeadersEnd(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = Buffer.alloc(0)

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx >= 0) {
        cleanup()
        const head = buf.subarray(0, idx + 4).toString('utf8')
        // 响应头之后可能已经有目标数据，塞回
        const rest = buf.subarray(idx + 4)
        if (rest.length > 0) socket.unshift(rest)

        // 处理 1xx 中间响应（100 Continue）
        const status = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head.split('\r\n')[0] ?? '')
        if (status && Number(status[1]) >= 100 && Number(status[1]) < 200) {
          // 继续等真正的响应
          resolve(readUntilHeadersEnd(socket, timeoutMs))
          return
        }
        resolve(head)
      }
      if (buf.length > 64 * 1024) {
        cleanup()
        reject(new ProxyError('代理响应头过大', 'reply'))
      }
    }

    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new ProxyError('代理在返回响应前断开连接', 'reply'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new ProxyError('等待代理响应超时', 'reply'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  })
}

/** 把 IPv6 字面量解析成 16 字节 */
function parseIpv6(host: string): Buffer | null {
  const clean = host.replace(/^\[|\]$/g, '')
  if (!/^[0-9a-fA-F:]+$/.test(clean)) return null

  const halves = clean.split('::')
  if (halves.length > 2) return null

  const parseGroups = (s: string): number[] =>
    s
      .split(':')
      .filter((x) => x.length > 0)
      .map((x) => parseInt(x, 16))

  const head = parseGroups(halves[0] ?? '')
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : []

  // 展开内嵌的 IPv4（如 ::ffff:192.168.1.1）
  const expandV4 = (groups: number[]): number[] => {
    const out: number[] = []
    for (const g of groups) out.push(g)
    return out
  }

  const headE = expandV4(head)
  const tailE = expandV4(tail)

  if (halves.length === 1) {
    if (headE.length !== 8) return null
    return Buffer.from(headE.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]))
  }

  const fill = 8 - headE.length - tailE.length
  if (fill < 0) return null
  const groups = [...headE, ...Array(fill).fill(0), ...tailE]
  if (groups.length !== 8) return null
  return Buffer.from(groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]))
}

/** 供 UI 展示的一句人类可读描述 */
export function describeProxy(proxy: ProxyConfig | undefined): string {
  if (!proxy || proxy.type === 'none') return '直连'
  const label = { socks5: 'SOCKS5', socks4: 'SOCKS4', http: 'HTTP' }[proxy.type] ?? proxy.type
  return `${label} ${proxy.host}:${proxy.port}`
}

/** TLS 包装（供需要 TLS 的转发场景） */
export function wrapTls(socket: Socket, servername: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername, rejectUnauthorized: false })
    tls.once('secureConnect', () => resolve(tls))
    tls.once('error', reject)
  })
}
