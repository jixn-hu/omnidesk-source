import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { Connection, Credential, ConfigurationSummary } from '@shared/types.js'
import type { OfficialAccountStatus, OfficialShare, OfficialUsers, OfficialAuthProviders, OfficialAdminSettings, OfficialAdminSettingsInput, OfficialBatchResult } from '@shared/account.js'
import type { VaultService } from './vault.js'
import type { ConfigurationBackupService, ConfirmConfiguration } from './config-backup.js'
import { writeConfigurationFile, writeConfigurationTransaction } from './config-backup.js'
import { OfficialTransport } from './official-transport.js'
import { sharedConfiguration } from '@shared/shared-configuration.js'

const SESSION_REF = 'official-account-session'
interface LoginSession { token: string; syncKey: string; expiresAt: number; user: NonNullable<OfficialAccountStatus['user']> }
interface AccountState { serverUrl: string; userId?: string; revision: number; lastSync?: number }
interface CloudConfiguration { revision: number; contents: string | null; updatedAt?: number }
class OfficialRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
interface Relay { close: () => void }
interface GitlabAttempt { id: string; secret: string; expiresAt: number; serverUrl: string; linkUserId?: string }
type PublishCredential = (Credential & { username: string; domain?: string }) | null

export class OfficialAccountService {
  private path: string
  private transport: OfficialTransport
  private state: AccountState = { serverUrl: '', revision: 0 }
  private busy = false
  private gitlabAttempt?: GitlabAttempt
  private relayServer?: Server
  private websocketServer?: WebSocketServer
  private listening?: Promise<number>
  private sessions = new Map<string, Relay>()
  private waiting = new Map<string, { sessionId: string; ticket: string; expires: number }>()

  constructor(private directory: string, private vault: VaultService, private backup: ConfigurationBackupService, private confirm: ConfirmConfiguration) {
    this.path = join(directory, 'official-account.json')
    this.transport = new OfficialTransport(directory, confirm)
    if (existsSync(this.path)) {
      try { const state = JSON.parse(readFileSync(this.path, 'utf8')); this.validateUrl(state.serverUrl); this.state = state } catch {}
    }
  }

  private validateUrl(value: string): string {
    if (typeof value !== 'string') throw new Error('请输入完整的官方服务地址')
    if (!value.trim()) return ''
    let url: URL
    try { url = new URL(value.trim()) } catch { throw new Error('请输入完整的官方服务地址') }
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('官方服务地址不能包含账号密码、查询参数或片段')
    return url.href.replace(/\/$/, '')
  }

  private login(): LoginSession | null {
    if (this.vault.status() !== 'unlocked') return null
    const saved = this.vault.getCredential(SESSION_REF)?.secret
    if (!saved) return null
    try {
      const session = JSON.parse(saved) as LoginSession & { serverUrl: string }
      return session.serverUrl === this.state.serverUrl && session.expiresAt > Date.now() ? session : null
    } catch { return null }
  }

  status(): OfficialAccountStatus {
    return { serverUrl: this.state.serverUrl, user: this.login()?.user ?? null, revision: this.state.revision, lastSync: this.state.lastSync }
  }

  private persist(state: AccountState): void {
    writeConfigurationFile(this.path, JSON.stringify(state))
    this.state = state
  }

  private persistLogin(state: AccountState, session: LoginSession | null): void {
    const prepared = this.vault.prepareCredentialImport(session ? { [SESSION_REF]: { secret: JSON.stringify({ ...session, serverUrl: state.serverUrl }) } } : {}, session ? [] : [SESSION_REF])
    writeConfigurationTransaction(this.directory, { 'vault.enc': prepared.contents, 'official-account.json': JSON.stringify(state) })
    prepared.commit()
    this.state = state
  }

  private async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.busy) throw new Error('官方账号操作正在进行，请稍后重试')
    if (this.vault.status() !== 'unlocked') throw new Error('请先解锁本机保险箱')
    this.busy = true
    try { return await operation() } finally { this.busy = false }
  }

  private async request<Result>(path: string, method = 'GET', body?: unknown, authenticated = true, timeoutMs = 30000): Promise<Result> {
    if (!this.state.serverUrl) throw new Error('请先填写并保存账号服务地址')
    const session = this.login()
    if (authenticated && !session) throw new Error('请先登录官方账号')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.transport.request(this.state.serverUrl + path, method, { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${session!.token}` } : {}) }, body === undefined ? undefined : JSON.stringify(body), controller.signal)
      if (response.status >= 300 && response.status < 400) throw new Error('官方服务返回重定向，请填写最终的 HTTPS 服务地址')
      let result: any
      try { result = JSON.parse(response.contents.toString('utf8')) } catch { throw new Error('官方服务响应无效，请检查服务地址和反向代理配置') }
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 && authenticated && this.vault.status() === 'unlocked') { this.vault.deleteCredential(SESSION_REF); this.releaseAll() }
        throw new OfficialRequestError(response.status, typeof result.error === 'string' ? result.error : '官方服务请求失败')
      }
      return result as Result
    } catch (error) {
      if (controller.signal.aborted) throw new Error('官方服务响应超时，请稍后重试')
      if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('无法连接官方服务，请检查服务地址或启动后台')
      throw error
    } finally { clearTimeout(timeout) }
  }

  configure(serverUrl: string): Promise<OfficialAccountStatus> {
    return this.run(async () => {
      serverUrl = this.validateUrl(serverUrl)
      if (serverUrl !== this.state.serverUrl) {
        this.cancelGitlab()
        if (this.login()) await this.request('/v1/logout', 'POST', undefined, true, 5000).catch(() => undefined)
        this.releaseAll()
        this.persistLogin({ serverUrl, revision: 0 }, null)
      }
      return this.status()
    })
  }

  authenticate(action: 'register' | 'login', username: string, password: string): Promise<OfficialAccountStatus> {
    return this.run(async () => {
      this.cancelGitlab()
      if (!['register', 'login'].includes(action)) throw new Error('账号操作无效')
      const result = await this.request<LoginSession>('/v1/auth/' + action, 'POST', { username, password }, false)
      if (!result.user?.id || typeof result.token !== 'string' || typeof result.syncKey !== 'string' || !Number.isFinite(result.expiresAt)) throw new Error('官方服务登录响应无效')
      this.releaseAll()
      const previous = this.login()
      if (previous) await this.request('/v1/logout', 'POST', undefined, true, 5000).catch(() => undefined)
      this.persistLogin({ serverUrl: this.state.serverUrl, userId: result.user.id, revision: this.state.userId === result.user.id ? this.state.revision : 0, lastSync: this.state.userId === result.user.id ? this.state.lastSync : undefined }, result)
      return this.status()
    })
  }

  logout(): Promise<OfficialAccountStatus> {
    return this.run(async () => {
      this.cancelGitlab()
      this.releaseAll()
      if (this.login()) await this.request('/v1/logout', 'POST', undefined, true, 5000).catch(() => undefined)
      this.persistLogin(this.state, null)
      return this.status()
    })
  }

  private async cloudConfiguration(): Promise<CloudConfiguration> {
    const result = await this.request<CloudConfiguration>('/v1/configuration')
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 ||
      (result.contents !== null && (typeof result.contents !== 'string' || !result.contents)) ||
      (result.revision === 0) !== (result.contents === null)) throw new Error('云端配置版本或内容无效，未上传或覆盖云端配置')
    return result
  }

  upload(): Promise<OfficialAccountStatus> {
    return this.run(async () => {
      const session = this.login()
      if (!session) throw new Error('请先登录官方账号')
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.cloudConfiguration()
        if (remote.contents && remote.revision !== this.state.revision) {
          const summary = await this.backup.restore(remote.contents, session.syncKey)
          if (!summary) throw new Error('已取消云端配置合并，未上传或覆盖云端配置')
          this.persist({ ...this.state, revision: remote.revision, lastSync: Date.now() })
        }
        // Build the encrypted snapshot after merging, and keep the server revision check for races.
        const contents = await this.backup.create(session.syncKey)
        try {
          const result = await this.request<{ revision: number; updatedAt: number }>('/v1/configuration', 'PUT', { revision: remote.revision, contents })
          this.persist({ ...this.state, revision: result.revision, lastSync: result.updatedAt })
          return this.status()
        } catch (error) {
          if (!(error instanceof OfficialRequestError) || error.status !== 409) throw error
        }
      }
      throw new Error('云端配置正在被其他设备连续更新，已停止上传以避免覆盖；本机配置已保留，请稍后重试')
    })
  }

  download(): Promise<ConfigurationSummary | null> {
    return this.run(async () => {
      const session = this.login()
      if (!session) throw new Error('请先登录官方账号')
      const result = await this.cloudConfiguration()
      if (!result.contents) throw new Error('账号还没有云端配置，请先在有配置的设备上传')
      const summary = await this.backup.restore(result.contents, session.syncKey)
      if (summary) this.persist({ ...this.state, revision: result.revision, lastSync: Date.now() })
      return summary
    })
  }

  shares(search = '', page = 0): Promise<{ items: OfficialShare[]; total: number }> {
    return this.request(`/v1/shares?search=${encodeURIComponent(search)}&page=${page}`)
  }

  users(search = '', page = 0): Promise<OfficialUsers> {
    return this.request(`/v1/admin/users?search=${encodeURIComponent(search)}&page=${page}`)
  }

  providers(): Promise<OfficialAuthProviders> { return this.request('/v1/auth/providers', 'GET', undefined, false) }
  settings(): Promise<OfficialAdminSettings> { return this.request('/v1/admin/settings') }
  saveSettings(input: OfficialAdminSettingsInput): Promise<OfficialAdminSettings> { return this.run(() => this.request('/v1/admin/settings', 'PUT', input)) }

  startGitlab(mode: 'login' | 'link'): Promise<{ id: string; expiresAt: number; authorizationUrl: string }> {
    return this.run(async () => {
      if (!['login', 'link'].includes(mode)) throw new Error('GitLab 登录操作无效')
      if (mode === 'link' && !this.login()) throw new Error('请先登录要绑定的官方账号')
      this.cancelGitlab()
      const result = await this.request<{ id: string; secret: string; expiresAt: number; authorizationUrl: string }>('/v1/auth/gitlab/start', 'POST', { mode }, mode === 'link')
      const expected = new URL(this.state.serverUrl + '/v1/auth/gitlab/authorize')
      const actual = new URL(result.authorizationUrl)
      const sameService = actual.origin === expected.origin || (expected.protocol === 'http:' && actual.protocol === 'https:' && actual.host === expected.host)
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.id) || !/^[A-Za-z0-9_-]{43}$/.test(result.secret) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || !sameService || actual.pathname !== expected.pathname || actual.username || actual.password || actual.hash || actual.searchParams.get('request') !== result.id) throw new Error('GitLab 登录响应或浏览器地址无效')
      this.gitlabAttempt = { id: result.id, secret: result.secret, expiresAt: result.expiresAt, serverUrl: this.state.serverUrl, linkUserId: mode === 'link' ? this.login()!.user.id : undefined }
      return { id: result.id, expiresAt: result.expiresAt, authorizationUrl: actual.href }
    })
  }

  cancelGitlab(id?: string): boolean {
    const attempt = this.gitlabAttempt
    if (!attempt || (id !== undefined && attempt.id !== id)) return false
    this.gitlabAttempt = undefined
    if (attempt.serverUrl === this.state.serverUrl) void this.request('/v1/auth/gitlab/cancel', 'POST', { id: attempt.id, secret: attempt.secret }, false, 5000).catch(() => {})
    return true
  }

  pollGitlab(id: string): Promise<{ state: 'pending' | 'complete'; status?: OfficialAccountStatus }> {
    return this.run(async () => {
      const attempt = this.gitlabAttempt
      if (!attempt || attempt.id !== id || attempt.expiresAt <= Date.now()) throw new Error('GitLab 登录已过期或取消，请重试')
      const result = await this.request<{ state: 'pending' | 'complete'; session?: LoginSession }>('/v1/auth/gitlab/poll', 'POST', { id, secret: attempt.secret }, false)
      if (this.gitlabAttempt !== attempt || attempt.serverUrl !== this.state.serverUrl || (attempt.linkUserId && this.login()?.user.id !== attempt.linkUserId)) throw new Error('GitLab 登录已取消或官方账号已变更')
      if (result.state === 'pending') return { state: 'pending' }
      const session = result.session
      if (result.state !== 'complete' || !session?.user?.id || !['admin', 'user'].includes(session.user.role) || typeof session.token !== 'string' || typeof session.syncKey !== 'string' || !Number.isFinite(session.expiresAt) || (attempt.linkUserId && session.user.id !== attempt.linkUserId)) throw new Error('GitLab 登录响应无效')
      if (this.vault.status() !== 'unlocked') throw new Error('保险箱已锁定，请解锁后重新登录')
      this.persistLogin({ serverUrl: this.state.serverUrl, userId: session.user.id, revision: this.state.userId === session.user.id ? this.state.revision : 0, lastSync: this.state.userId === session.user.id ? this.state.lastSync : undefined }, session)
      this.gitlabAttempt = undefined
      this.releaseAll()
      return { state: 'complete', status: this.status() }
    })
  }

  batchIds(input: string[]): string[] {
    if (!Array.isArray(input) || !input.length || input.length > 50 || input.some(id => typeof id !== 'string' || !id.length || id.length > 128)) throw new Error('每次请选择 1–50 条记录')
    return [...new Set(input)]
  }

  private async preparePublication(connection: Connection, credential: PublishCredential) {
    if (!credential?.secret || !credential.username.trim()) throw new Error('请先补齐服务器账号和凭据，再发布共享')
    if ((connection.proxy && connection.proxy.type !== 'none') || connection.vpn?.name || (connection.kind === 'ssh' && connection.jump)) throw new Error('请先移除本机代理、VPN 或跳板机依赖，再共享独立连接配置；下载者可在本机单独配置这些选项')
    if (connection.kind === 'ssh' && connection.authMethod === 'agent') throw new Error('共享连接需要保存密码或私钥，不能使用本机 SSH Agent')
    const configuration = sharedConfiguration({ ...connection, username: credential.username, domain: credential.domain })
    const metadata = { ...configuration, sharingMode: 'copy', credentialDisclosure: true, configuration }
    const inspected = await this.request<{ fingerprint?: string; existing?: { id: string; updatedAt: number } }>('/v1/shares/check-target', 'POST', metadata)
    return { ...metadata, credential: { secret: credential.secret, passphrase: credential.passphrase ?? undefined }, trustedFingerprint: inspected.fingerprint, existingId: inspected.existing?.id, existingUpdatedAt: inspected.existing?.updatedAt }
  }

  publishMany(items: Array<{ connection: Connection; credential: PublishCredential; error?: string }>): Promise<OfficialBatchResult> {
    return this.run(async () => {
      this.batchIds(items.map(item => item.connection.id))
      items = [...new Map(items.map(item => [item.connection.id, item])).values()]
      const result: OfficialBatchResult = { succeeded: 0, failed: [], cancelled: false }
      const prepared: Array<{ id: string; payload: Awaited<ReturnType<OfficialAccountService['preparePublication']>> }> = []
      for (let offset = 0; offset < items.length; offset += 4) {
        await Promise.all(items.slice(offset, offset + 4).map(async ({ connection, credential, error }) => {
          try {
            if (error) throw new Error(error)
            prepared.push({ id: connection.id, payload: await this.preparePublication(connection, credential) })
          }
          catch (error) { result.failed.push({ id: connection.id, name: connection.name, message: error instanceof Error ? error.message : '共享预检查失败' }) }
        }))
      }
      if (!prepared.length) return result
      const detail = prepared.map(({ payload }) => `${payload.existingId ? '更新' : '新增'} · ${payload.name} · ${payload.kind.toUpperCase()} · ${payload.username}@${payload.host}`).join('\n')
      if (!await this.confirm(`批量发布 / 更新 ${prepared.length} 台服务器配置？`, '所有已登录账号均可下载这些配置及密码 / 私钥，并在本机查看、修改和独立使用。撤销共享不能收回已下载的副本。请勿发布不希望其他人获得的凭据。\n\n相同入口仍只保留一条；更新不会覆盖其他人的本地副本。\n\n' + detail + (result.failed.length ? `\n\n另有 ${result.failed.length} 条未通过预检查，将跳过。` : ''))) { result.cancelled = true; return result }
      for (const { id, payload } of prepared) {
        try { await this.request('/v1/shares', 'POST', payload); result.succeeded++ }
        catch (error) { result.failed.push({ id, name: payload.name, message: error instanceof Error ? error.message : '共享发布失败' }) }
      }
      return result
    })
  }

  unpublishMany(input: string[]): Promise<OfficialBatchResult> {
    return this.run(async () => {
      const ids = this.batchIds(input)
      const result: OfficialBatchResult = { succeeded: 0, failed: [], cancelled: false }
      if (!await this.confirm(`批量撤销 ${ids.length} 台服务器共享？`, '只能撤销自己发布的云端配置；已下载的本地副本不受影响，本机连接及公共凭据不删除。')) { result.cancelled = true; return result }
      for (const id of ids) {
        try { await this.request('/v1/shares/' + encodeURIComponent(id), 'DELETE'); result.succeeded++ }
        catch (error) { result.failed.push({ id, name: id, message: error instanceof Error ? error.message : '撤销失败' }) }
      }
      return result
    })
  }

  publish(connection: Connection, credential: Credential & { username: string; domain?: string }): Promise<{ id: string } | null> {
    return this.run(async () => {
      const payload = await this.preparePublication(connection, credential)
      if (!await this.confirm(payload.existingId ? '更新云端共享配置？' : '发布可下载的服务器配置？', `所有已登录账号均可下载「${connection.name}」的配置及密码 / 私钥，在本机查看、修改和独立使用。\n\n撤销共享无法收回已下载的副本；更新不会覆盖其他人的本地配置。请勿共享不希望其他人获得的凭据。`)) return null
      return this.request('/v1/shares', 'POST', payload)
    })
  }

  unpublish(shareId: string): Promise<boolean> {
    return this.run(async () => {
      if (!await this.confirm('撤销服务器共享？', '配置将从云端目录移除；其他人已下载的本地副本不删除，本机连接和公共凭据保留。')) return false
      await this.request('/v1/shares/' + encodeURIComponent(shareId), 'DELETE')
      return true
    })
  }

  importShare(shareId: string): Promise<{ connectionId: string; skipped: boolean } | null> {
    return this.run(async () => {
      if (typeof shareId !== 'string' || !shareId.length || shareId.length > 128) throw new Error('共享配置标识不正确')
      const payload = await this.request<unknown>('/v1/shares/' + encodeURIComponent(shareId) + '/configuration')
      return this.backup.importSharedConnection(payload)
    })
  }

  private listen(): Promise<number> {
    if (this.listening) return this.listening
    this.listening = new Promise((resolve, reject) => {
      const server = this.relayServer = createServer((_request, response) => { response.writeHead(404).end() })
      const websocketServer = this.websocketServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false })
      server.on('upgrade', (request, socket, head) => {
        let address: URL
        try { address = new URL(request.url ?? '/', 'http://localhost') } catch { return socket.destroy() }
        const token = address.pathname.slice(1)
        const pending = this.waiting.get(token)
        this.waiting.delete(token)
        if (!pending || pending.expires < Date.now() || !this.login()) return socket.destroy()
        websocketServer.handleUpgrade(request, socket, head, client => {
          const url = new URL(this.state.serverUrl + '/tunnel')
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
          url.searchParams.set('ticket', pending.ticket)
          const upstream = new WebSocket(url, 'guacamole', { ...this.transport.tlsOptions(new URL(this.state.serverUrl)), handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false })
          const queue: Array<{ data: Buffer; binary: boolean }> = []
          let queuedSize = 0
          const close = () => { client.close(); upstream.close(); this.sessions.delete(pending.sessionId) }
          this.sessions.set(pending.sessionId, { close })
          const forward = (destination: WebSocket, data: Buffer, binary: boolean) => {
            if (destination.readyState !== WebSocket.OPEN || destination.bufferedAmount > 8 * 1024 * 1024) return close()
            destination.send(data, { binary })
          }
          client.on('message', (data, binary) => {
            const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
            if (upstream.readyState === WebSocket.CONNECTING) {
              queuedSize += buffer.byteLength
              if (queuedSize > 128 * 1024) return close()
              queue.push({ data: buffer, binary })
            } else forward(upstream, buffer, binary)
          })
          upstream.once('open', () => { for (const entry of queue) forward(upstream, entry.data, entry.binary); queue.length = 0 })
          upstream.on('message', (data, binary) => forward(client, data as Buffer, binary))
          client.on('close', close); upstream.on('close', close)
          client.on('error', close); upstream.on('error', close)
        })
      })
      server.once('error', error => { this.listening = undefined; reject(error) })
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    return this.listening
  }

  async connect(shareId: string, width: number, height: number): Promise<{ sessionId: string; url: string }> {
    const { ticket } = await this.request<{ ticket: string }>('/v1/shares/' + encodeURIComponent(shareId) + '/ticket', 'POST', { width, height })
    const port = await this.listen()
    const sessionId = randomUUID()
    const token = randomBytes(32).toString('hex')
    this.waiting.set(token, { sessionId, ticket, expires: Date.now() + 30000 })
    const timeout = setTimeout(() => this.waiting.delete(token), 30000)
    timeout.unref()
    return { sessionId, url: `ws://127.0.0.1:${port}/${token}` }
  }

  release(sessionId: string): boolean {
    for (const [token, pending] of this.waiting) if (pending.sessionId === sessionId) this.waiting.delete(token)
    this.sessions.get(sessionId)?.close()
    return true
  }

  releaseAll(): void {
    this.waiting.clear()
    for (const session of [...this.sessions.values()]) session.close()
  }

  dispose(): void {
    this.cancelGitlab()
    this.releaseAll()
    this.websocketServer?.close()
    this.relayServer?.close()
  }
}
