import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionStore } from './connection-store'
import type { VaultService } from './vault'
import type { ServerMetrics } from '@shared/types'
import { EMPTY_ASSET, type MonitorAsset, type MonitorEntry, type MonitorLocal, type MonitorConfig, type MonitorNode } from '@shared/monitoring'

import { MonitorDiscoveryService } from './monitor-discovery'
import { writeConfigurationTransaction } from './config-backup'

interface Data { config: Omit<MonitorConfig, 'hasToken'>; entries: MonitorEntry[]; notified: string[]; agentConnections: Record<string, { connectionId: string; host: string; port: number }> }
export class MonitoringService {
  private path: string
  private data: Data = { config: { enabled: false, url: '', allowInsecure: false, mode: 'account', defaultIntervalSeconds: 60 }, entries: [], notified: [], agentConnections: {} }
  private histories = new Map<string, ServerMetrics[]>()
  private requests = new Set<AbortController>()
  private discovery: MonitorDiscoveryService
  private accountProvider?: () => {key:string;url:string;token?:string} | undefined
  private accountRequest?: <T>(path:string,method?:string,body?:unknown)=>Promise<T>
  setAccountProvider(provider:NonNullable<MonitoringService['accountProvider']>,request:NonNullable<MonitoringService['accountRequest']>):void { this.accountProvider=provider; this.accountRequest=request }
  accountChanged():void { this.generation++; for(const request of this.requests) request.abort(); this.histories.clear(); this.preparingNodes.clear() }
  private runtimeConfig() { const context=this.accountProvider?.(); return {...this.data.config,url:context?.url ?? '',scopeKey:context?.key ?? '',allowInsecure:context?.url.startsWith('http:') ?? false} }

  private generation = 0
  private loadError = ''
  private preparingNodes = new Map<string, Promise<MonitorNode>>()
  constructor(private directory: string, private vault: VaultService, private connections: ConnectionStore, private fetcher: typeof fetch, notify: (message: string) => void) {
    this.discovery = new MonitorDiscoveryService(fetcher)
    this.path = join(directory, 'monitoring.json')
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Data>
        if (!saved || !Array.isArray(saved.entries) || !saved.config || typeof saved.config.enabled !== 'boolean' || typeof saved.config.url !== 'string') throw new Error('invalid shape')
        for (const entry of saved.entries) { if (!entry || typeof entry.connectionId !== 'string' || !['ssh', 'agent'].includes(entry.source)) throw new Error('invalid entry'); entry.asset = this.asset(entry.asset) }
        if (saved.notified && (!Array.isArray(saved.notified) || saved.notified.some(item => typeof item !== 'string'))) throw new Error('invalid reminders')
        this.data = { config: { ...this.data.config, ...saved.config, mode:'account', url:'', allowInsecure:false }, entries: saved.entries, notified: saved.notified ?? [], agentConnections: saved.agentConnections ?? {} }
      } catch { this.loadError = '本机监控配置读取失败，原文件已保留，请检查 monitoring.json' }
    }
  }
  backupScope() { const config = this.runtimeConfig(); return { url: config.url, key: config.scopeKey, prefix: `omnidesk-monitor-agent:${createHash('sha256').update(config.url + '\0' + config.scopeKey).digest('hex')}:` } }
  backupConfiguration(): Omit<Data, 'notified'> & { account: { url: string; key: string } } {
    if (this.loadError) throw new Error(this.loadError)
    const { url, key, prefix } = this.backupScope()
    const entries = this.data.entries.filter(item => item.source === 'ssh' || !!item.nodeId && !!this.data.agentConnections[prefix + item.nodeId])
    return structuredClone({ config: this.data.config, account: { url, key }, entries, agentConnections: Object.fromEntries(Object.entries(this.data.agentConnections).filter(([ref]) => ref.startsWith(prefix))) })
  }
  prepareBackup(input: any, ids: Map<string, string>): { contents: string; url: string; commit(): void } {
    if (this.loadError) throw new Error(this.loadError)
    if (!input || typeof input.config?.enabled !== 'boolean' || input.config.mode !== 'account' || !Array.isArray(input.entries) || input.entries.length > 10000 || !input.agentConnections || typeof input.agentConnections !== 'object' || Array.isArray(input.agentConnections)) throw new Error('监控备份格式不正确')
    const config = { enabled: input.config.enabled, url: '', allowInsecure: false, mode: 'account' as const, defaultIntervalSeconds: input.config.defaultIntervalSeconds ?? 60 }
    if (!Number.isInteger(config.defaultIntervalSeconds) || config.defaultIntervalSeconds < 5 || config.defaultIntervalSeconds > 86400) throw new Error('无效默认采集周期')
    const scope = this.backupScope()
    if ((input.entries.some((item: any) => item?.source === 'agent') || Object.keys(input.agentConnections).length) && (input.account?.url !== scope.url || input.account?.key !== scope.key || !scope.key)) throw new Error('请先登录备份对应的账号，再恢复云端监控关联')
    const entries: MonitorEntry[] = []
    for (const item of input.entries) {
      if (!item || typeof item.connectionId !== 'string' || !['ssh', 'agent'].includes(item.source) || item.nodeId !== undefined && !/^[a-f0-9]{24}$/.test(item.nodeId)) throw new Error('监控节点关联格式不正确')
      const connectionId = ids.get(item.connectionId)
      if (connectionId) entries.push({ connectionId, source: item.source, ...(item.nodeId ? { nodeId: item.nodeId } : {}), asset: this.asset(item.asset) })
    }
    const agentConnections: Data['agentConnections'] = {}
    for (const [ref, binding] of Object.entries(input.agentConnections) as [string, any][]) {
      if (!ref.startsWith(scope.prefix) || !/^[a-f0-9]{24}$/.test(ref.slice(scope.prefix.length)) || !binding || typeof binding.connectionId !== 'string' || typeof binding.host !== 'string' || !Number.isInteger(binding.port) || binding.port < 1 || binding.port > 65535) throw new Error('采集端关联格式不正确')
      const connectionId = ids.get(binding.connectionId)
      if (connectionId) agentConnections[ref] = { connectionId, host: binding.host, port: binding.port }
    }
    const next: Data = { config, entries: [...new Map([...this.data.entries, ...entries].map(item => [item.connectionId, item])).values()], agentConnections: { ...this.data.agentConnections, ...agentConnections }, notified: this.data.notified }
    return { contents: JSON.stringify(next), url: scope.url, commit: () => {
      this.generation++; for (const request of this.requests) request.abort()
      this.data = next; this.histories.clear()
    } }
  }

  private migrateOwnedAgentBindings(nodes: MonitorNode[]): void {
    const scope = this.backupScope()
    if (!scope.url || !scope.key || this.vault.status() !== 'unlocked') return
    // Legacy credentials were scoped by URL. Only recover bindings from this
    // instance; node IDs alone cannot prove which server issued a credential.
    const urls = [scope.url, scope.url.replace(/\/v1\/monitor$/, '')]
    const legacyPrefixes = [...new Set(urls)].map(url => `omnidesk-monitor-agent:${createHash('sha256').update(url).digest('hex')}:`)
    const prefix = scope.prefix, next = structuredClone(this.data)
    const credentials: Record<string, { secret: string }> = {}, removed: string[] = []
    for (const node of nodes) for (const legacyPrefix of legacyPrefixes) {
      if (!/^[a-f0-9]{24}$/.test(node.id)) continue
      const oldRef = legacyPrefix + node.id, ref = prefix + node.id
      const binding = next.agentConnections[oldRef]
      if (!binding) continue
      if (!next.agentConnections[ref]) next.agentConnections[ref] = binding
      const token = this.vault.getCredential(oldRef)
      if (token && !this.vault.getCredential(ref)) credentials[ref] = { secret: token.secret }
      delete next.agentConnections[oldRef]; removed.push(oldRef)
    }
    if (!removed.length) return
    const prepared = this.vault.prepareCredentialImport(credentials, removed)
    writeConfigurationTransaction(this.directory, { 'monitoring.json': JSON.stringify(next), 'vault.enc': prepared.contents })
    prepared.commit(); this.data = next
  }
  private persist(): void { if (this.loadError) throw new Error(this.loadError); writeFileSync(this.path + '.tmp', JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 }); renameSync(this.path + '.tmp', this.path) }
  local(): MonitorLocal {
    if (this.loadError) throw new Error(this.loadError)
    const config=this.runtimeConfig()
    const hasToken = !!this.accountProvider?.()?.token
    return structuredClone({ config: { ...config, hasToken }, entries: this.data.entries.filter(item => !!this.connections.get(item.connectionId) && (item.source==='ssh' || !!item.nodeId && !!this.data.agentConnections[this.agentTokenRef(item.nodeId)])).map(item => item.discoveredHost === this.connections.get(item.connectionId)?.host ? item : { ...item, discovered: undefined, discoveredHost: undefined }) })
  }
  configure(input: { enabled: boolean; mode?: 'account'; defaultIntervalSeconds?: number }): MonitorLocal {
    if (this.loadError) throw new Error(this.loadError)
    if (!input || typeof input.enabled !== 'boolean') throw new Error('无效监控开关')
    if (Object.keys(input).some(key => !['enabled','mode','defaultIntervalSeconds'].includes(key)) || input.mode !== undefined && input.mode !== 'account') throw new Error('监控使用当前账号，无需单独配置地址或令牌')
    if(input.defaultIntervalSeconds!==undefined && (!Number.isInteger(input.defaultIntervalSeconds) || input.defaultIntervalSeconds<5 || input.defaultIntervalSeconds>86400)) throw new Error('采集上报周期须为 5 至 86400 秒')
    this.generation++; for (const request of this.requests) request.abort()
    this.data.config = { enabled:input.enabled,mode:'account',url:'',allowInsecure:false,defaultIntervalSeconds:input.defaultIntervalSeconds ?? this.data.config.defaultIntervalSeconds ?? 60 }
    this.persist(); return this.local()
  }

  private agentTokenRef(id: string): string {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('无效监控节点')
    return this.backupScope().prefix + id
  }
  agentInstallation(id: string) {
    if (this.vault.status() !== 'unlocked') throw new Error('请先解锁本机保险箱')
    const config=this.runtimeConfig()
    if (!config.enabled || !config.url) throw new Error('请先登录账号并开启监控服务')
    const ref = this.agentTokenRef(id)
    const binding = this.data.agentConnections[ref]
    return { url: config.url, allowInsecure: config.allowInsecure, defaultIntervalSeconds:config.defaultIntervalSeconds ?? 60, token: this.vault.getCredential(ref)?.secret, revision: this.generation, connectionId: binding && this.agentNodeForConnection(binding.connectionId) === id ? binding.connectionId : undefined }
  }
  assertInstallRevision(revision: number): void {
    if (this.vault.status() !== 'unlocked' || revision !== this.generation || !this.data.config.enabled) throw new Error('监控配置或保险箱状态已变化，请重新安装')
  }
  async saveNode(input: { id?: string; name: string; group: string; asset: MonitorAsset; intervalSeconds?: number }) {
    if (input.id && !/^[a-f0-9]{24}$/.test(input.id)) throw new Error('无效节点')
    const revision = this.generation
    const result = await this.request<{ node?: MonitorNode; token?: string; ok?: boolean }>(input.id ? '/v1/nodes/' + input.id : '/v1/nodes', input.id ? 'PUT' : 'POST', {...input,...(!input.id && input.intervalSeconds===undefined ? {intervalSeconds:this.data.config.defaultIntervalSeconds ?? 60}:{})})
    this.assertInstallRevision(revision)
    if (result.node && result.token) this.vault.setCredential(this.agentTokenRef(result.node.id), result.token)
    return result
  }
  agentNodeForConnection(connectionId: string): string | undefined {
    const prefix = this.agentTokenRef('000000000000000000000000').slice(0, -24)
    const connection = this.connections.get(connectionId)
    return Object.entries(this.data.agentConnections).find(([key, value]) => key.startsWith(prefix) && value.connectionId === connectionId && value.host === connection?.host && value.port === connection?.port)?.[0].slice(-24)
  }
  rememberAgentConnection(id: string, connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (!connection) throw new Error('请选择已保存的服务器')
    const ref = this.agentTokenRef(id), prefix = ref.slice(0, -24)
    for (const [key, value] of Object.entries(this.data.agentConnections)) if (key !== ref && key.startsWith(prefix) && value.connectionId === connectionId) delete this.data.agentConnections[key]
    this.data.agentConnections[ref] = { connectionId, host: connection.host, port: connection.port }; this.persist()
  }
  forgetAgentConnection(id: string): void { delete this.data.agentConnections[this.agentTokenRef(id)]; this.persist() }
  prepareAgentNode(connectionId: string): Promise<MonitorNode> {
    const connection = this.connections.get(connectionId)
    if (!connection) return Promise.reject(new Error('请选择已保存的服务器'))
    const key = this.runtimeConfig().url + ':' + this.runtimeConfig().scopeKey + ':' + connectionId
    const pending = this.preparingNodes.get(key)
    if (pending) return pending
    const revision = this.generation
    const operation = (async () => {
      const nodes = await this.request<MonitorNode[]>('/v1/nodes')
      this.assertInstallRevision(revision)
      const existing = nodes.find(node => node.id === this.agentNodeForConnection(connectionId))
      if (existing) return existing
      const result = await this.saveNode({ name: connection.name, group: connection.group ?? '', asset: { ...EMPTY_ASSET } })
      if (!result.node) throw new Error('节点创建结果无效，请刷新监控列表')
      this.rememberAgentConnection(result.node.id, connectionId)
      return result.node
    })()
    this.preparingNodes.set(key, operation)
    void operation.finally(() => this.preparingNodes.delete(key)).catch(() => {})
    return operation
  }
  async removeNode(id: string): Promise<void> {
    const ref = this.agentTokenRef(id), revision = this.generation
    try { await this.request('/v1/nodes/' + id, 'DELETE') }
    catch (error) { if (error instanceof Error && error.message.includes('HTTP 404')) throw new Error('监控服务尚不支持删除节点，请更新服务端'); throw error }
    this.assertInstallRevision(revision)
    this.vault.deleteCredential(ref)
    delete this.data.agentConnections[ref]
    this.persist()
  }
  async rotateAgentToken(id: string) {
    this.agentTokenRef(id)
    const revision = this.generation
    const result = await this.request<{ token: string }>('/v1/nodes/' + id + '/token', 'POST')
    this.assertInstallRevision(revision)
    this.vault.setCredential(this.agentTokenRef(id), result.token)
    return result
  }
  private asset(input: MonitorAsset): MonitorAsset {
    const a = { ...EMPTY_ASSET, ...input }
    new Intl.DateTimeFormat('en-CA', { timeZone: a.timezone })
    if (a.expiresAt && (!/^\d{4}-\d{2}-\d{2}$/.test(a.expiresAt) || new Date(a.expiresAt).toISOString().slice(0, 10) !== a.expiresAt)) throw new Error('无效到期日期')
    if (!['sum', 'up', 'down', 'max', 'min'].includes(a.trafficMode) || !Number.isInteger(a.resetDay) || a.resetDay < 1 || a.resetDay > 31) throw new Error('流量设置无效')
    for (const key of ['price', 'trafficLimit', 'initialUpload', 'initialDownload'] as const) if (!Number.isFinite(a[key]) || a[key] < 0 || a[key] > Number.MAX_SAFE_INTEGER) throw new Error('价格或流量数值无效')
    for (const key of ['provider', 'region', 'currency', 'billingCycle', 'vendorUrl', 'initialPeriod'] as const) if (typeof a[key] !== 'string' || a[key].length > 2048) throw new Error('资料格式无效')
    return a
  }
  saveEntry(input: MonitorEntry): MonitorLocal {
    const connection = this.connections.get(input.connectionId)
    if (connection?.kind !== 'ssh') throw new Error('请选择有效的 SSH 连接')
    if (!['ssh', 'agent'].includes(input.source)) throw new Error('采集方式无效')
    if (input.source === 'agent' && (!this.data.config.enabled || !/^[a-f0-9]{24}$/.test(input.nodeId ?? ''))) throw new Error('请先启用常驻服务并关联节点')
    const entry: MonitorEntry = { connectionId: connection.id, source: input.source, asset: this.asset(input.asset), ...(input.source === 'agent' ? { nodeId: input.nodeId } : {}) }
    const previous = this.data.entries.find(item => item.connectionId === entry.connectionId)
    if (previous && previous.discoveredHost === connection.host) { entry.discovered = previous.discovered; entry.discoveredHost = previous.discoveredHost }
    this.data.entries = [...this.data.entries.filter(item => item.connectionId !== entry.connectionId && !(entry.nodeId && item.nodeId === entry.nodeId)), entry]
    this.persist(); void this.discover(entry.connectionId).catch(() => {}); return this.local()
  }
  removeEntry(id: string): MonitorLocal { this.data.entries = this.data.entries.filter(item => item.connectionId !== id); this.histories.delete(id); this.persist(); return this.local() }
  record(metrics: ServerMetrics): void {
    if (!this.data.entries.some(entry => entry.connectionId === metrics.connectionId && (entry.source === 'ssh' || !this.data.config.enabled))) return
    void this.discover(metrics.connectionId).catch(() => {})
    const points = this.histories.get(metrics.connectionId) ?? []
    if (points.at(-1)?.timestamp === metrics.timestamp) return
    this.histories.set(metrics.connectionId, [...points.filter(item => item.timestamp > Date.now() - 3600000).slice(-719), metrics])
  }
  private async discover(id: string): Promise<void> {
    if (this.loadError || this.vault.status() !== 'unlocked') return
    const entry = this.data.entries.find(item => item.connectionId === id)
    const host = this.connections.get(id)?.host
    if (!entry || !host || entry.source === 'agent' && this.data.config.enabled || entry.discoveredHost === host && entry.discovered && entry.discovered.detectedAt > Date.now() - 86400000) return
    const discovered = await this.discovery.lookup(host)
    const current = this.data.entries.find(item => item.connectionId === id)
    if (!discovered || !current || this.connections.get(id)?.host !== host || this.loadError || this.vault.status() !== 'unlocked' || current.source === 'agent' && this.data.config.enabled) return
    current.discovered = discovered; current.discoveredHost = host; this.persist()
  }
  localHistory(id: string): ServerMetrics[] { return this.histories.get(id) ?? [] }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const config = this.runtimeConfig()
    if(!config.enabled) throw new Error('常驻监控未开启')
    if(!this.accountRequest || !this.accountProvider?.()?.token) throw new Error('请先登录账号云端')
    const generation=this.generation
    const result=await this.accountRequest<T>(path,method,body)
    if(generation!==this.generation) throw new Error('当前账号或监控配置已切换，请重新刷新')
    if (method === 'GET' && path === '/v1/nodes' && Array.isArray(result)) this.migrateOwnedAgentBindings(result)
    return result
  }
}
