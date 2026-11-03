import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import * as tls from 'node:tls'
import { rdpCertificateAuthorities } from './rdp-certificates.js'
import { writeConfigurationFile, type ConfirmConfiguration } from './config-backup.js'

interface TrustedCertificate { pem: string; fingerprint: string }
interface HttpResult { status: number; contents: Buffer }
const certificateErrors = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'OFFICIAL_CERT_CHANGED'])

export class OfficialTransport {
  private path: string
  private certificates: Record<string, TrustedCertificate> = {}
  private pending = new Map<string, Promise<void>>()

  constructor(directory: string, private confirm: ConfirmConfiguration) {
    this.path = join(directory, 'official-certificates.json')
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, 'utf8'))
        for (const [origin, value] of Object.entries(saved.certificates ?? {})) {
          const certificate = value as TrustedCertificate
          if (new URL(origin).origin !== origin || !origin.startsWith('https:') || typeof certificate.pem !== 'string') continue
          if (new X509Certificate(certificate.pem).fingerprint256 === certificate.fingerprint) this.certificates[origin] = certificate
        }
      } catch {}
    }
  }

  tlsOptions(url: URL): tls.ConnectionOptions {
    const trusted = this.certificates[url.origin]
    const roots = rdpCertificateAuthorities() ?? tls.rootCertificates
    return {
      ca: trusted ? [...roots, trusted.pem] : [...roots],
      checkServerIdentity: (hostname, certificate) => {
        const error = tls.checkServerIdentity(hostname, certificate)
        if (error) return error
        if (trusted && certificate.fingerprint256 !== trusted.fingerprint) return Object.assign(new Error('官方服务证书发生变化'), { code: 'OFFICIAL_CERT_CHANGED' })
        return undefined
      }
    }
  }

  private send(url: URL, method: string, headers: Record<string, string>, contents: string | undefined, signal: AbortSignal): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const secure = url.protocol === 'https:'
      const request = (secure ? httpsRequest : httpRequest)(url, { method, headers: { ...headers, ...(contents === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(contents)) }) }, signal, agent: false, ...(secure ? this.tlsOptions(url) : {}) }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 20 * 1024 * 1024) { response.destroy(new Error('官方服务返回的数据过大')); return }
          chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('aborted', () => reject(new Error('官方服务响应中断，请重试')))
        response.once('end', () => resolve({ status: response.statusCode ?? 500, contents: Buffer.concat(chunks) }))
      })
      request.once('error', reject)
      request.end(contents)
    })
  }

  private async trust(url: URL, signal: AbortSignal): Promise<void> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const peer = await new Promise<tls.PeerCertificate>((resolve, reject) => {
      if (signal.aborted) { reject(new Error('读取官方服务证书已取消')); return }
      const socket = tls.connect({ host: hostname, port: Number(url.port || 443), servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: false })
      const abort = () => socket.destroy(new Error('读取官方服务证书已取消'))
      signal.addEventListener('abort', abort, { once: true })
      socket.once('close', () => { signal.removeEventListener('abort', abort); reject(new Error('官方服务 TLS 连接在证书读取完成前关闭')) })
      socket.setTimeout(8000, () => socket.destroy(new Error('读取官方服务证书超时')))
      socket.once('error', reject)
      socket.once('secureConnect', () => { const certificate = socket.getPeerCertificate(); socket.destroy(); resolve(certificate) })
    })
    if (!peer.raw) throw new Error('官方服务没有提供有效的 TLS 证书')
    const identityError = tls.checkServerIdentity(hostname, peer)
    if (identityError) throw new Error('官方服务证书与地址不匹配，请检查域名或 IP，不会发送账号密码')
    const certificate = new X509Certificate(peer.raw)
    if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) < Date.now()) throw new Error('官方服务证书已过期或尚未生效，不会发送账号密码')
    if (signal.aborted) throw new Error('官方服务证书确认已取消')
    const previous = this.certificates[url.origin]
    const accepted = await this.confirm(previous ? '官方服务证书发生变化，是否重新信任？' : '核对内网官方服务证书', `服务地址：${url.origin}\n\n主体：${certificate.subject}\n颁发者：${certificate.issuer}\n有效期：${certificate.validFrom} — ${certificate.validTo}\n\nSHA-256 指纹：\n${certificate.fingerprint256}` + (previous ? `\n\n之前信任的指纹：\n${previous.fingerprint}` : '') + '\n\n请与后台管理员核对指纹，确认后仅信任这个服务，不修改系统证书库；证书确认前不会发送账号密码。')
    if (!accepted || signal.aborted) throw new Error('未信任官方服务证书，未发送账号密码')
    const certificates = { ...this.certificates, [url.origin]: { pem: certificate.toString(), fingerprint: certificate.fingerprint256 } }
    writeConfigurationFile(this.path, JSON.stringify({ version: 1, certificates }))
    this.certificates = certificates
  }

  async request(address: string, method: string, headers: Record<string, string>, contents: string | undefined, signal: AbortSignal): Promise<HttpResult> {
    const url = new URL(address)
    try { return await this.send(url, method, headers, contents, signal) }
    catch (error) {
      if (url.protocol !== 'https:' || !certificateErrors.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      let pending = this.pending.get(url.origin)
      if (!pending) {
        pending = this.trust(url, signal).finally(() => this.pending.delete(url.origin))
        this.pending.set(url.origin, pending)
      }
      await pending
      return this.send(url, method, headers, contents, signal)
    }
  }
}
