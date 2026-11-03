import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigurationSummary, WebDavConfiguration, WebDavConfigurationInput } from '@shared/types.js'
import { ConfigurationBackupService, writeConfigurationFile, writeConfigurationTransaction, type ConfirmConfiguration } from './config-backup.js'
import type { VaultService } from './vault.js'

interface StoredWebDav {
  url: string
  serverUrl?: string
  username: string
  allowInsecureHttp: boolean
  hasPassword: boolean
  etag?: string
  lastSync?: number
}

const PASSWORD_REF = 'webdav-sync-password'
const MAXIMUM = 16 * 1024 * 1024

export class WebDavSyncService {
  private readonly path: string
  private state: StoredWebDav = { url: '', username: '', allowInsecureHttp: false, hasPassword: false }
  private busy = false

  constructor(private readonly directory: string, private readonly vault: VaultService, private readonly backup: ConfigurationBackupService, private readonly confirm: ConfirmConfiguration) {
    this.path = join(directory, 'webdav-sync.json')
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, 'utf8')) as StoredWebDav
        this.validate(saved)
        this.state = { ...saved, hasPassword: saved.hasPassword === true }
      } catch {}
    }
  }

  configuration(): WebDavConfiguration {
    const { url, serverUrl, username, allowInsecureHttp, hasPassword, lastSync } = this.state
    return { url, serverUrl, username, allowInsecureHttp, hasPassword, lastSync }
  }

  save(input: WebDavConfigurationInput): WebDavConfiguration {
    if (this.busy) throw new Error('同步正在进行，请完成后再修改配置')
    this.validate(input)
    if (this.vault.status() !== 'unlocked') throw new Error('请先解锁保险箱，再保存 WebDAV 凭据')
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 4096)) throw new Error('WebDAV 密码格式不正确')
    const password = input.clearPassword ? '' : input.password
    const changed = input.url !== this.state.url || input.username !== this.state.username || !!password || input.clearPassword
    const next = { ...this.state, url: input.url.trim(), serverUrl: input.serverUrl, username: input.username.trim(), allowInsecureHttp: input.allowInsecureHttp, ...(changed ? { etag: undefined, lastSync: undefined } : {}) }
    if (input.clearPassword) next.hasPassword = false
    else if (password) next.hasPassword = true
    const prepared = this.vault.prepareCredentialImport(password ? { [PASSWORD_REF]: { secret: password } } : {}, input.clearPassword ? [PASSWORD_REF] : [])
    writeConfigurationTransaction(this.directory, { 'vault.enc': prepared.contents, 'webdav-sync.json': JSON.stringify(next) })
    prepared.commit()
    this.state = next
    return this.configuration()
  }

  private validate(input: { url: string; serverUrl?: string; username: string; allowInsecureHttp: boolean }): void {
    if (typeof input.url !== 'string' || input.url.length > 4096 || typeof input.username !== 'string' || input.username.length > 1024 || /[:\r\n\0]/.test(input.username) || typeof input.allowInsecureHttp !== 'boolean') throw new Error('WebDAV 配置格式不正确')
    let url: URL
    try { url = new URL(input.url.trim()) } catch { throw new Error('请填写完整的 WebDAV 备份文件 URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname.endsWith('/')) throw new Error('请填写 HTTP(S) 备份文件地址，而不是目录；账号密码请在独立字段填写，不支持查询参数或片段')
    if (input.serverUrl !== undefined) {
      let server: URL
      try { server = new URL(input.serverUrl) } catch { throw new Error('WebDAV 服务器地址格式不正确') }
      if (typeof input.serverUrl !== 'string' || input.serverUrl.length > 4096 || server.username || server.password || server.hash || server.search || !server.pathname.endsWith('/') || !url.href.startsWith(server.href)) throw new Error('WebDAV 备份位置必须位于服务器地址之下')
    }
    if (url.protocol === 'http:' && !input.allowInsecureHttp) throw new Error('HTTP 会暴露 WebDAV 账号和密码；请使用 HTTPS，或显式允许不安全 HTTP')
  }

  private async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.busy) throw new Error('已有 WebDAV 操作进行中，请稍后重试')
    this.validate(this.state)
    if (this.vault.status() !== 'unlocked') throw new Error('请先解锁保险箱，再使用 WebDAV')
    this.busy = true
    try { return await operation() } finally { this.busy = false }
  }

  private async request(method: 'HEAD' | 'GET' | 'PUT' | 'MKCOL', options: { body?: string; headers?: Record<string, string>; url?: string } = {}): Promise<{ status: number; etag?: string; body: string }> {
    const secret = this.state.hasPassword ? this.vault.getCredential(PASSWORD_REF)?.secret : ''
    if (this.state.hasPassword && !secret) throw new Error('WebDAV 密码不可用，请重新保存')
    const authorization = this.state.username || secret ? { Authorization: `Basic ${Buffer.from(`${this.state.username}:${secret ?? ''}`, 'utf8').toString('base64')}` } : undefined
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch(options.url ?? this.state.url, { method, headers: { ...authorization, ...options.headers }, body: options.body, redirect: 'error', signal: controller.signal })
      const chunks: Uint8Array[] = []
      let size = 0
      if (response.body) {
        const reader = response.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAXIMUM) { controller.abort(); throw new Error('WebDAV 响应超过 16MB，已中止') }
            chunks.push(value)
          }
        } finally { reader.releaseLock() }
      }
      return { status: response.status, etag: response.headers.get('etag') ?? undefined, body: Buffer.concat(chunks).toString('utf8') }
    } catch (error) {
      if (error instanceof Error && error.message.includes('16MB')) throw error
      throw new Error('WebDAV 网络请求失败或超时；请检查 URL、网络和 HTTPS 证书。不会跟随重定向或忽略证书错误。')
    } finally { clearTimeout(timeout) }
  }

  private requireStatus(status: number, accepted: number[]): void {
    if (accepted.includes(status)) return
    if (status === 401 || status === 403) throw new Error(`WebDAV 认证或访问权限失败（HTTP ${status}），请检查账号、应用密码及目录权限`)
    if (status === 409) throw new Error('WebDAV 备份目录不存在，请先在服务器创建该目录')
    if (status === 412) throw new Error('远端备份已被其他设备修改，已阻止覆盖；请先下载并确认远端配置')
    throw new Error(`WebDAV 请求失败（HTTP ${status}）`)
  }

  private remember(etag?: string): string | undefined {
    const next = { ...this.state, etag, lastSync: Date.now() }
    this.state = next
    try { writeConfigurationFile(this.path, JSON.stringify(next)) }
    catch { return '操作已成功，但本机同步时间 / 版本记录保存失败，请检查数据目录写入权限后重新保存 WebDAV 配置。' }
  }

  private async metadata(): Promise<{ status: number; etag?: string; body: string }> {
    const response = await this.request('HEAD')
    return [405, 501].includes(response.status) ? await this.request('GET') : response
  }

  private async ensureDirectories(): Promise<void> {
    if (!this.state.serverUrl) return
    const target = new URL(this.state.url)
    const base = new URL(this.state.serverUrl)
    const parts = target.pathname.slice(base.pathname.length).split('/').slice(0, -1)
    for (const part of parts) {
      base.pathname += part + '/'
      const response = await this.request('MKCOL', { url: base.href })
      this.requireStatus(response.status, [200, 201, 204, 405])
    }
  }

  async test(): Promise<string> {
    return await this.run(async () => {
      const remote = await this.metadata()
      this.requireStatus(remote.status, [200, 204, 404])
      return remote.status === 404 ? 'WebDAV 可访问；远端备份尚未创建，首次上传时创建文件' : 'WebDAV 备份文件可访问；上传权限将在实际上传时检查'
    })
  }

  async upload(password: string): Promise<string> {
    return await this.run(async () => {
      const encrypted = await this.backup.create(password)
      await this.ensureDirectories()
      const remote = await this.metadata()
      this.requireStatus(remote.status, [200, 204, 404])
      const creating = remote.status === 404
      const strongEtag = remote.etag && !remote.etag.startsWith('W/') ? remote.etag : undefined
      if (!creating && strongEtag && this.state.etag && this.state.etag !== strongEtag) throw new Error('远端备份已被其他设备更新，请先下载并确认；未覆盖远端')
      if (!await this.confirm(creating ? '上传加密配置？' : '更新远端加密配置？', '仅上传 AES-256-GCM 加密的连接、公共凭据、密码和私钥。\n\n' + (creating ? '将在指定 URL 创建备份文件。' : '这会替换远端备份文件，不会直接修改其他设备。' + (!strongEtag ? '\\n此服务器不提供版本标识，无法检测同时写入；请确认其他设备没有正在上传。' : '')))) return '已取消上传'
      const response = await this.request('PUT', { body: encrypted, headers: { 'Content-Type': 'application/json', ...(creating ? { 'If-None-Match': '*' } : strongEtag ? { 'If-Match': strongEtag } : {}) } })
      this.requireStatus(response.status, [200, 201, 204])
      const warning = this.remember(response.etag)
      return '加密配置已上传；其他设备下载时需输入同一备份密码' + (warning ? `。注意：${warning}` : '')
    })
  }

  async download(password: string): Promise<ConfigurationSummary | null> {
    return await this.run(async () => {
      const response = await this.request('GET')
      if (response.status === 404) throw new Error('远端还没有备份，请先从另一台设备上传')
      this.requireStatus(response.status, [200])
      const summary = await this.backup.restore(response.body, password)
      if (summary) {
        const warning = this.remember(response.etag)
        if (warning) summary.warning = warning
      }
      return summary
    })
  }
}
