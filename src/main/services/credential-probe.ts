import { randomUUID } from 'node:crypto'
import type { Connection, SharedCredential } from '@shared/types.js'
import type { CredentialProbeResult, CredentialProbeStep } from '@shared/credential-probe.js'
import type { ConnectionStore } from './connection-store.js'
import type { SharedCredentialStore } from './shared-credentials.js'
import type { SshService } from './ssh.js'
import type { RdpProxyService } from './rdp-proxy.js'
import type { VaultService } from './vault.js'
import { resolveConnectionCredential } from './credential-resolver.js'
import { formatConnectionAddress, parseConnectionAddress } from '@shared/connection-identity.js'

interface ProbeJob {
  id: string
  queue: Array<{ connection: Connection; credential: SharedCredential }>
  results: CredentialProbeResult[]
  snapshots: Map<string, { connection: Connection; credential: SharedCredential }>
  stopped: boolean
  busy: boolean
  lastAttempt: number
  pending?: { connection: Connection; credential: SharedCredential; sessionId: string }
  timer: ReturnType<typeof setTimeout>
}

export class CredentialProbeService {
  private job?: ProbeJob

  constructor(private connections: ConnectionStore, private shared: SharedCredentialStore, private vault: VaultService, private ssh: SshService, private rdp: RdpProxyService) {}

  start(connectionIds: string[], credentialIds: string[]): string {
    if (this.job && !this.job.stopped && (this.job.queue.length || this.job.busy || this.job.pending)) throw new Error('已有凭据测试进行中，请先停止')
    if (!Array.isArray(connectionIds) || !Array.isArray(credentialIds) || !connectionIds.length || connectionIds.length > 100 || !credentialIds.length || credentialIds.length > 3) throw new Error('每批选择 1–100 台服务器、1–3 条公共凭据')
    if (this.vault.status() !== 'unlocked') throw new Error('请先解锁保险箱')
    const queue: ProbeJob['queue'] = []
    for (const connectionId of new Set(connectionIds)) {
      const connection = this.connections.get(connectionId)
      if (!connection) throw new Error('所选连接已删除，请刷新列表')
      for (const credentialId of new Set(credentialIds)) {
        const credential = this.shared.get(credentialId)
        if (!credential) throw new Error('所选公共凭据已删除')
        if (connection.kind === 'rdp' && credential.kind !== 'password') continue
        queue.push({ connection, credential })
      }
    }
    if (!queue.length) throw new Error('没有兼容的凭据；RDP 只支持密码凭据')
    if (this.job) clearTimeout(this.job.timer)
    const id = randomUUID()
    this.job = { id, queue, results: [], snapshots: new Map(), stopped: false, busy: false, lastAttempt: 0, timer: setTimeout(() => this.cancel(id), 10 * 60_000) }
    return id
  }

  private requireJob(id: string): ProbeJob {
    if (!this.job || this.job.id !== id) throw new Error('测试已过期，请重新开始')
    return this.job
  }

  private record(job: ProbeJob, connection: Connection, credential: SharedCredential, success: boolean, message: string): CredentialProbeResult {
    const result = { connectionId: connection.id, credentialId: credential.id, success, message }
    job.results.push(result)
    if (success) {
      job.queue = job.queue.filter(item => item.connection.id !== connection.id)
      job.snapshots.set(connection.id, { connection, credential })
    }
    return result
  }

  async next(id: string): Promise<CredentialProbeStep> {
    const job = this.requireJob(id)
    if (job.busy || job.pending) throw new Error('上一条测试尚未结束')
    if (job.stopped || !job.queue.length) return { done: true }
    job.busy = true
    const { connection, credential } = job.queue.shift()!
    const candidate: Connection = connection.kind === 'ssh'
      ? { ...connection, sharedCredentialId: credential.id, authMethod: credential.kind }
      : { ...connection, sharedCredentialId: credential.id }
    try {
      const pause = Math.max(0, 1500 - (Date.now() - job.lastAttempt))
      if (pause) await new Promise(resolve => setTimeout(resolve, pause))
      if (job.stopped) return { done: true }
      job.lastAttempt = Date.now()
      if (candidate.kind === 'ssh') {
        const session = await this.ssh.connect(candidate, job.id)
        this.ssh.disconnect(session.id)
        if (job.stopped) return { done: true }
        return { done: false, result: this.record(job, connection, credential, true, 'SSH 认证成功，测试会话已断开') }
      }
      const resolved = resolveConnectionCredential(candidate, this.shared, this.vault)
      if (!resolved?.secret) throw new Error('凭据内容为空')
      const endpoint = parseConnectionAddress(candidate.host, candidate.port)
      const transport = await this.rdp.prepare(endpoint.host, endpoint.port, candidate.options ?? {}, candidate.proxy)
      if (job.stopped) { this.rdp.release(transport.sessionId); return { done: true } }
      job.pending = { connection, credential, sessionId: transport.sessionId }
      return { done: false, rdp: { connectionId: connection.id, credentialId: credential.id, transport, username: resolved.username, domain: resolved.domain, password: resolved.secret, destination: formatConnectionAddress(endpoint.host, endpoint.port) } }
    } catch (error) {
      if (job.stopped) return { done: true }
      const message = error instanceof Error ? error.message : '测试失败'
      const authFailure = /认证失败|authentication methods failed/i.test(message)
      if (!authFailure) job.queue = job.queue.filter(item => item.connection.id !== connection.id)
      return { done: false, result: this.record(job, connection, credential, false, authFailure ? '账号或凭据未通过认证' : '连接或身份验证未完成；请先单独连接检查网络、主机指纹和认证方式') }
    } finally { job.busy = false }
  }

  finishRdp(id: string, success: boolean): CredentialProbeResult {
    const job = this.requireJob(id)
    const pending = job.pending
    if (!pending || job.stopped) throw new Error('RDP 测试已取消')
    job.pending = undefined
    this.rdp.release(pending.sessionId)
    return this.record(job, pending.connection, pending.credential, success === true, success ? 'RDP 会话建立成功，测试会话已断开' : 'RDP 未建立会话：可能是密码、网络或服务器策略问题')
  }

  cancel(id: string): boolean {
    const job = this.requireJob(id)
    job.stopped = true
    job.queue = []
    clearTimeout(job.timer)
    for (const session of this.ssh.list()) if (session.ownerId === id) this.ssh.disconnect(session.id)
    if (job.pending) this.rdp.release(job.pending.sessionId)
    job.pending = undefined
    return true
  }

  apply(id: string, connectionId: string): boolean {
    const saved = this.requireJob(id).snapshots.get(connectionId)
    if (!saved) throw new Error('该服务器没有认证成功的凭据')
    const connection = this.connections.get(connectionId)
    const credential = this.shared.get(saved.credential.id)
    if (!connection || !credential || JSON.stringify(connection) !== JSON.stringify(saved.connection) || JSON.stringify(credential) !== JSON.stringify(saved.credential)) throw new Error('连接或凭据已更改，请重新测试后再应用')
    this.connections.save(connection.kind === 'ssh' ? { ...connection, sharedCredentialId: credential.id, authMethod: credential.kind } : { ...connection, sharedCredentialId: credential.id })
    return true
  }
}
