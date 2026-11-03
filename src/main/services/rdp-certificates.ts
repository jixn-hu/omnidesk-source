import { X509Certificate } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import * as tls from 'node:tls'
import { rdpAddress } from './rdp-protocol.js'

export interface RdpCertificatePrompt {
  host: string
  port: number
  subject: string
  issuer: string
  fingerprint: string
  previousFingerprint?: string
  validFrom: string
  validTo: string
  reason: string
}

export type RdpCertificateDecision = 'reject' | 'once' | 'remember'
type ConfirmCertificate = (certificate: RdpCertificatePrompt, signal: AbortSignal) => Promise<RdpCertificateDecision>

export function rdpCertificateAuthorities(): string[] | undefined {
  const runtime = tls as typeof tls & { getCACertificates?: (type: 'default' | 'system') => string[] }
  try {
    if (runtime.getCACertificates) {
      const roots = [...new Set([...runtime.getCACertificates('default'), ...runtime.getCACertificates('system')])]
      if (roots.length) return roots
    }
  } catch {}
  return undefined
}

export class RdpCertificateVerifier {
  private readonly path?: string
  private pins: Record<string, string> = {}

  constructor(directory?: string, private readonly confirm?: ConfirmCertificate) {
    this.path = directory ? join(directory, 'rdp-trusted-certificates.json') : undefined
    if (this.path && existsSync(this.path)) {
      try {
        const stored = JSON.parse(readFileSync(this.path, 'utf8')) as { version: number; fingerprints: Record<string, unknown> }
        if (stored.version === 1 && stored.fingerprints && typeof stored.fingerprints === 'object') {
          this.pins = Object.fromEntries(Object.entries(stored.fingerprints).filter((entry): entry is [string, string] =>
            typeof entry[1] === 'string' && /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(entry[1])))
        }
      } catch {}
    }
  }

  async verify(host: string, port: number, socket: tls.TLSSocket, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('RDP 证书验证已取消')
    const peer = socket.getPeerCertificate()
    if (!peer.raw) throw new Error('RDP 服务器没有提供 TLS 证书')
    const certificate = new X509Certificate(peer.raw)
    const identityError = tls.checkServerIdentity(host, peer)
    const authorization = socket.authorizationError
    await this.verifyCertificate(host, port, certificate, socket.authorized && !identityError,
      identityError?.message ?? (authorization instanceof Error ? authorization.message : authorization) ?? '无法建立可信的服务器证书链', signal)
  }

  async verifyPem(host: string, port: number, pem: Uint8Array, signal: AbortSignal): Promise<void> {
    const certificate = new X509Certificate(Buffer.from(pem))
    await this.verifyCertificate(host, port, certificate, false, 'FreeRDP 需要核对服务器证书指纹；请向管理员确认后再信任', signal)
  }

  private async verifyCertificate(host: string, port: number, certificate: X509Certificate, trusted: boolean, failure: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('RDP 证书验证已取消')
    const destination = rdpAddress(host.toLowerCase(), port)
    const previousFingerprint = this.pins[destination]
    const matchesPin = previousFingerprint === certificate.fingerprint256
    const validNow = Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) >= Date.now()
    if ((trusted && (!previousFingerprint || matchesPin)) || (matchesPin && validNow)) return
    const reason = previousFingerprint && !matchesPin ? '服务器证书已变化，必须重新确认身份' :
      failure
    if (!this.confirm) throw new Error(`RDP 证书校验失败：${reason}；当前未启用忽略证书错误`)
    const decision = await this.confirm({ host, port, subject: certificate.subject, issuer: certificate.issuer,
      fingerprint: certificate.fingerprint256, previousFingerprint,
      validFrom: certificate.validFrom, validTo: certificate.validTo, reason }, signal)
    if (signal.aborted) throw new Error('RDP 证书验证已取消')
    if (decision !== 'once' && decision !== 'remember') throw new Error(`已拒绝 RDP 服务器证书：${reason}；未发送登录凭据`)
    if (decision === 'remember') {
      const next = { ...this.pins, [destination]: certificate.fingerprint256 }
      if (this.path) {
        writeFileSync(`${this.path}.tmp`, JSON.stringify({ version: 1, fingerprints: next }, null, 2), 'utf8')
        renameSync(`${this.path}.tmp`, this.path)
      }
      this.pins = next
    }
  }
}
