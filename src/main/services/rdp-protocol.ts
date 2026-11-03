import type { Socket } from 'node:net'

const VERSION = 3390

export class RdpNegotiationError extends Error {
  constructor(message: string, public readonly negotiationCode: number | 'legacy') {
    super(message)
    this.name = 'RdpNegotiationError'
  }
}

function element(tag: number, content: Buffer): Buffer {
  let length = Buffer.from([content.length])
  if (content.length >= 128) {
    const bytes: number[] = []
    let remaining = content.length
    while (remaining > 0) {
      bytes.unshift(remaining & 255)
      remaining >>>= 8
    }
    length = Buffer.from([128 | bytes.length, ...bytes])
  }
  return Buffer.concat([Buffer.from([tag]), length, content])
}

function integer(value: number): Buffer {
  const bytes: number[] = []
  do {
    bytes.unshift(value & 255)
    value >>>= 8
  } while (value)
  if (bytes[0] & 128) bytes.unshift(0)
  return element(2, Buffer.from(bytes))
}

function field(index: number, content: Buffer): Buffer {
  return element(160 + index, content)
}

function readElement(data: Buffer, offset = 0): { tag: number; value: Buffer; end: number } {
  if (offset + 2 > data.length) throw new Error('RDCleanPath 数据不完整')
  const tag = data[offset++]
  let length = data[offset++]
  if (length & 128) {
    const count = length & 127
    if (!count || count > 3 || offset + count > data.length) {
      throw new Error('RDCleanPath 长度无效')
    }
    length = 0
    for (let index = 0; index < count; index++) length = length * 256 + data[offset++]
  }
  const end = offset + length
  if (end > data.length) throw new Error('RDCleanPath 数据被截断')
  return { tag, value: data.subarray(offset, end), end }
}

export function parseRdpRequest(data: Buffer): { destination: string; token: string; x224: Buffer } {
  if (data.length > 65_536) throw new Error('RDCleanPath 握手数据过大')
  const outer = readElement(data)
  if (outer.tag !== 48 || outer.end !== data.length) throw new Error('不是有效的 RDCleanPath 请求')
  const fields = new Map<number, { tag: number; value: Buffer }>()
  let offset = 0
  while (offset < outer.value.length) {
    const context = readElement(outer.value, offset)
    if (context.tag < 160 || context.tag > 169 || fields.has(context.tag)) {
      throw new Error('RDCleanPath 字段无效')
    }
    const inner = readElement(context.value)
    if (inner.end !== context.value.length) throw new Error('RDCleanPath 字段长度无效')
    fields.set(context.tag, inner)
    offset = context.end
  }
  const version = fields.get(160)
  if (version?.tag !== 2 || !version.value.equals(Buffer.from([13, 62]))) {
    throw new Error('不支持的 RDCleanPath 协议版本')
  }
  const destination = fields.get(162)
  const token = fields.get(163)
  const x224 = fields.get(166)
  if (destination?.tag !== 12 || token?.tag !== 12 || x224?.tag !== 4) {
    throw new Error('RDCleanPath 请求缺少目标、认证令牌或 X.224 数据')
  }
  if (fields.has(165)) throw new Error('此连接暂不支持 RDP 预连接数据')
  if (x224.value.length < 11 || x224.value[0] !== 3 || x224.value[1] !== 0 ||
      x224.value.readUInt16BE(2) !== x224.value.length) {
    throw new Error('X.224 连接请求无效')
  }
  return { destination: destination.value.toString('utf8'), token: token.value.toString('utf8'), x224: x224.value }
}

export function rdpResponse(address: string, x224: Buffer, certificates: Buffer[]): Buffer {
  return element(48, Buffer.concat([
    field(0, integer(VERSION)),
    field(6, element(4, x224)),
    field(7, element(48, Buffer.concat(certificates.map((certificate) => element(4, certificate))))),
    field(9, element(12, Buffer.from(address)))
  ]))
}

export function rdpErrorResponse(): Buffer {
  return element(48, Buffer.concat([
    field(0, integer(VERSION)),
    field(1, element(48, field(0, integer(1))))
  ]))
}

export function rdpAddress(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}

export function exchangeX224(socket: Socket, request: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error('RDP X.224 协商超时')), 15_000)
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', fail)
      socket.off('close', onClose)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => fail(new Error('目标在 RDP 协商阶段关闭了连接'))
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (received.length < 4) return
      const length = received.readUInt16BE(2)
      if (received[0] !== 3 || received[1] !== 0 || length < 11 || length > 8192) {
        fail(new Error('目标端口没有返回有效的 RDP X.224 响应'))
        return
      }
      if (received.length < length) return
      socket.pause()
      cleanup()
      if (received.length > length) socket.unshift(received.subarray(length))
      const response = received.subarray(0, length)
      if (response[5] !== 208 || response[4] !== length - 5) {
        reject(new Error('目标没有接受 RDP X.224 连接请求'))
        return
      }
      const negotiation = response.subarray(11)
      if (negotiation.length === 8 && negotiation.readUInt16LE(2) === 8 && negotiation[0] === 3) {
        const code = negotiation.readUInt32LE(4)
        const reasons: Record<number, string> = {
          1: 'SSL_REQUIRED_BY_SERVER：目标要求 TLS 或 CredSSP 安全协议，请核对服务器支持的协议与客户端请求',
          2: 'SSL_NOT_ALLOWED_BY_SERVER：目标仅接受旧版 RDP 安全层，拒绝 TLS / NLA；IronRDP 不支持这种安全层。可在连接配置中选择 FreeRDP 及旧版 RDP 安全层（需确认风险），或使用系统远程桌面；优先由管理员在服务器启用 TLS / NLA',
          3: 'SSL_CERT_NOT_ON_SERVER：服务器没有可用的 TLS 身份证书，请管理员修复远程桌面证书及私钥权限；忽略证书错误不能修复服务器缺少证书',
          4: 'INCONSISTENT_FLAGS：服务器当前安全协议与协商请求不一致，请检查 RDP 网关或安全层策略',
          5: 'HYBRID_REQUIRED_BY_SERVER：服务器要求 CredSSP / NLA，请确认客户端支持并保持服务器 NLA 开启',
          6: 'SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER：服务器要求 TLS 客户端证书认证；仅账号和密码不足以满足此策略',
          7: 'ENTRA_AUTH_REQUIRED_BY_SERVER：服务器要求 Microsoft Entra 身份验证，当前账号密码连接方式不支持；请使用支持该认证的系统客户端'
        }
        reject(new RdpNegotiationError(`RDP 安全协商被目标拒绝（代码 ${code}）\n${reasons[code] ?? '服务器返回了未识别的安全协商失败代码，请管理员检查服务器日志'}`, code))
      } else if (!negotiation.length || (negotiation.length === 8 && negotiation[0] === 2 &&
          negotiation.readUInt16LE(2) === 8 && negotiation.readUInt32LE(4) === 0)) {
        reject(new RdpNegotiationError('STANDARD_RDP_SECURITY：目标未协商 TLS，仅支持旧版 RDP 安全层。需要用户确认后才能使用 FreeRDP 旧版模式，或使用系统远程桌面；优先由管理员启用 TLS / NLA，不会未经同意降低安全层或发送登录凭据', 'legacy'))
      } else if (negotiation.length !== 8 || negotiation[0] !== 2 ||
          negotiation.readUInt16LE(2) !== 8 || ![1, 2, 8].includes(negotiation.readUInt32LE(4))) {
        reject(new Error('目标返回了无效或不支持的 RDP 安全协商响应'))
      } else {
        resolve(response)
      }
    }
    socket.on('data', onData)
    socket.once('error', fail)
    socket.once('close', onClose)
    socket.write(request)
    socket.resume()
  })
}
