import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AiApproval, AiApprovalRequest, AiApprovalRecord, AiApprovalOutcome, AiConfiguration, AiConfigurationInput, AiMessage, AiState, AiConversationState, AiPermissionMode } from '@shared/ai.js'
import { AI_DEFAULT_MAX_MODEL_CALLS, AI_MAX_MODEL_CALLS, aiPermissionModes } from '@shared/ai.js'
import { matchesConnection } from '@shared/connection-identity.js'
import { applyMetadataChanges } from '@shared/server-metadata.js'
import type { Connection, ExecResult, SshConnection, RdpConnection } from '@shared/types.js'
import type { MetadataChanges } from '@shared/server-metadata.js'
import type { ConnectionStore } from './connection-store.js'
import type { VaultService } from './vault.js'
import { writeConfigurationTransaction } from './config-backup.js'
import { aiSystemPrompt, aiTools, linuxQueries, windowsQueries, type WindowsTopic, publicServer, redactAiText } from './ai-tools.js'

const CONVERSATIONS_FILE = 'ai-conversations.enc'
const CONVERSATIONS_CONTEXT = 'OmniDesk AI conversations v1'
const API_KEY_REF = 'omnidesk-ai-api-key'
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
type ConversationSnapshot = { value: AiConversationState; history: ChatMessage[]; historyTrimmed: boolean }
type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
interface AiOptions {
  execute: (connection: SshConnection, command: string, signal: AbortSignal, beforeExecute: (destination: string) => void, conversationId?: string) => Promise<ExecResult>
  inspectWindows?: (connection: RdpConnection, topic: WindowsTopic, signal: AbortSignal, beforeInspect: (destination: string) => void) => Promise<ExecResult>
  metadataChanged?: () => void
  destination?: (connection: Connection) => string
  approvalTimeoutMs?: number
}
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('AI 工具参数格式不正确')
  return value as Record<string, any>
}
function endpoint(value: string): URL {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请填写完整的 AI 接口地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('AI 接口须为 HTTP / HTTPS 地址，不能包含账号密码、查询参数或片段')
  url.pathname = url.pathname.replace(/\/$/, '')
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions'
  return url
}

class AiConversation extends EventEmitter {
  private configurationValue = { baseUrl: '', model: '', maxModelCalls: AI_DEFAULT_MAX_MODEL_CALLS, permissionMode: 'read' as AiPermissionMode }
  private value: AiConversationState = { status: 'idle', messages: [], pending: null, selectedIds: [], scopeMode: 'all', scopeCount: 0, permissionMode: 'read', modelCalls: 0, maxModelCalls: AI_DEFAULT_MAX_MODEL_CALLS }
  private history: ChatMessage[] = []
  private controller?: AbortController
  private approval?: { id: string; resolve: (outcome: Exclude<AiApprovalOutcome, 'pending'>) => void; expiresAt: number }
  private testing = false
  private createdThisTurn = 0
  private historyTrimmed = false
  readonly id: string
  constructor(private directory: string, private connections: ConnectionStore, private vault: VaultService, private options: AiOptions, id: string = randomUUID()) {
    super()
    this.id = id
    const path = join(directory, 'ai-settings.json')
    if (existsSync(path)) {
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof saved.baseUrl === 'string' && typeof saved.model === 'string') {
          if (saved.baseUrl) endpoint(saved.baseUrl)
          this.configurationValue = { baseUrl: saved.baseUrl, model: saved.model, maxModelCalls: Number.isSafeInteger(saved.maxModelCalls) && saved.maxModelCalls >= 1 && saved.maxModelCalls <= AI_MAX_MODEL_CALLS ? saved.maxModelCalls : AI_DEFAULT_MAX_MODEL_CALLS, permissionMode: aiPermissionModes.some(mode => mode.value === saved.permissionMode) ? saved.permissionMode : 'read' }
        }
      } catch {}
    }
    this.value.permissionMode = this.configurationValue.permissionMode
    this.value.maxModelCalls = this.configurationValue.maxModelCalls
  }
  private requireUnlocked(): void { if (this.vault.status() !== 'unlocked') throw new Error('请先解锁本机保险箱') }
  private key(): string { this.requireUnlocked(); return this.vault.getCredential(API_KEY_REF)?.secret ?? '' }
  private clean(text: string): string {
    const key = this.vault.status() === 'unlocked' ? this.vault.getCredential(API_KEY_REF)?.secret : ''
    return redactAiText(text, key ? [key] : [])
  }
  configuration(): AiConfiguration {
    return { ...this.configurationValue, hasApiKey: this.vault.status() === 'unlocked' && !!this.key() }
  }
  saveConfiguration(input: AiConfigurationInput): AiConfiguration {
    this.requireUnlocked()
    if (this.controller || this.testing) throw new Error('请先停止当前 AI 任务，再修改模型配置')
    object(input, ['baseUrl', 'model', 'apiKey', 'clearApiKey', 'maxModelCalls', 'permissionMode'])
    if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048 || typeof input.model !== 'string' || input.model.length > 256 || /[\0\r\n]/.test(input.model)) throw new Error('AI 接口地址或模型名称格式不正确')
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192 || /[\0\r\n]/.test(input.apiKey))) throw new Error('API Key 格式不正确')
    if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new Error('清除 API Key 参数格式不正确')
    if (input.maxModelCalls !== undefined && (!Number.isSafeInteger(input.maxModelCalls) || input.maxModelCalls < 1 || input.maxModelCalls > AI_MAX_MODEL_CALLS)) throw new Error(`单轮模型调用上限须为 1–${AI_MAX_MODEL_CALLS} 的整数`)
    if (input.permissionMode !== undefined && !aiPermissionModes.some(mode => mode.value === input.permissionMode)) throw new Error('请选择有效的 AI 权限模式')
    const baseUrl = input.baseUrl.trim(), model = input.model.trim()
    if (!baseUrl || !model) throw new Error('请明确填写 AI 接口地址和模型名称')
    endpoint(baseUrl)
    const key = input.clearApiKey ? '' : input.apiKey?.trim() || this.key()
    const prepared = this.vault.prepareCredentialImport(key ? { [API_KEY_REF]: { secret: key } } : {}, key ? [] : [API_KEY_REF])
    const next = { baseUrl: baseUrl.replace(/\/$/, ''), model, maxModelCalls: input.maxModelCalls ?? this.configurationValue.maxModelCalls, permissionMode: input.permissionMode ?? this.configurationValue.permissionMode }
    writeConfigurationTransaction(this.directory, { 'ai-settings.json': JSON.stringify(next), 'vault.enc': prepared.contents })
    prepared.commit()
    this.configurationValue = next
    if (input.permissionMode !== undefined && !this.value.messages.some(message => message.role === 'user')) this.value.permissionMode = input.permissionMode
    this.value.maxModelCalls = next.maxModelCalls
    this.value.modelCalls = 0
    this.history = []
    return this.configuration()
  }
  busy(): boolean { return !!this.controller || this.testing }
  applyConfiguration(configuration: AiConfiguration): void {
    this.configurationValue = { baseUrl: configuration.baseUrl, model: configuration.model, maxModelCalls: configuration.maxModelCalls, permissionMode: configuration.permissionMode }
    this.value.maxModelCalls = configuration.maxModelCalls
    this.value.modelCalls = 0
    this.history = []
    this.historyTrimmed = false
  }
  setPermissionMode(mode: AiPermissionMode): void {
    this.requireUnlocked()
    if (!aiPermissionModes.some(item => item.value === mode)) throw new Error('请选择有效的 AI 权限模式')
    if (this.busy()) throw new Error('请先完成或停止此对话的任务，再切换权限模式')
    if (mode === this.value.permissionMode) return
    this.value.permissionMode = mode
    this.history = []
    this.historyTrimmed = false
    this.message('activity', `已切换为${aiPermissionModes.find(item => item.value === mode)!.label}，模型上下文已重新开始。`)
  }
  private allowed(name: string): boolean {
    if (['ask_user', 'list_servers', 'inspect_linux', 'inspect_windows'].includes(name)) return true
    if (['create_server', 'update_metadata'].includes(name)) return this.value.permissionMode !== 'read'
    return this.value.permissionMode === 'full' && ['delete_server', 'run_ssh'].includes(name)
  }
  private compactHistory(): void {
    while (this.history.length > 160 || JSON.stringify(this.history).length > 300000) {
      const nextTurn = this.history.findIndex((message, index) => index > 0 && message.role === 'user')
      if (nextTurn > 0) this.history.splice(0, nextTurn)
      else {
        const index = this.history.findIndex(message => message.role === 'assistant' && !!message.tool_calls?.length)
        if (index < 0) throw new Error('对话上下文过长，请缩小任务范围或新建对话')
        let end = index + 1
        while (this.history[end]?.role === 'tool') end++
        this.history.splice(index, end - index)
      }
      this.historyTrimmed = true
    }
  }
  snapshot(): ConversationSnapshot { return structuredClone({ value: this.value, history: this.history, historyTrimmed: this.historyTrimmed }) }
  restore(snapshot: ConversationSnapshot): void {
    if (!snapshot?.value || !Array.isArray(snapshot.value.messages) || snapshot.value.messages.length > 1200 || !Array.isArray(snapshot.value.selectedIds) || !Array.isArray(snapshot.history) || !aiPermissionModes.some(mode => mode.value === snapshot.value.permissionMode)) throw new Error('对话记录格式不正确')
    this.value = structuredClone(snapshot.value)
    this.history = structuredClone(snapshot.history)
    this.historyTrimmed = !!snapshot.historyTrimmed
    const interrupted = this.value.status !== 'idle'
    this.value.status = 'idle'
    this.value.pending = null
    this.value.selectedIds = this.value.selectedIds.filter(id => !!this.connections.get(id))
    this.value.scopeMode = snapshot.value.scopeMode ?? (snapshot.value.selectedIds.length ? 'selected' : 'all')
    this.value.scopeCount = this.value.scopeMode === 'all' ? this.connections.list().length : this.value.selectedIds.length
    for (const message of this.value.messages) if (message.approval?.outcome === 'pending') message.approval.outcome = 'stopped'
    // Supply a result for every unfinished tool call so resumed histories stay protocol-valid.
    for (let index = 0; index < this.history.length; index++) {
      const calls = this.history[index].tool_calls
      if (!calls?.length) continue
      let end = index + 1
      const completed = new Set<string>()
      while (this.history[end]?.role === 'tool') { completed.add(this.history[end].tool_call_id!); end++ }
      const missing = calls.filter(call => !completed.has(call.id)).map(call => ({ role: 'tool' as const, tool_call_id: call.id, content: JSON.stringify({ interrupted: true, rejected: true, reason: '客户端退出时此操作的结果未完整记录。先核实实际状态，不得沿用旧确认或重复执行修改操作。' }) }))
      this.history.splice(end, 0, ...missing)
      index = end + missing.length - 1
    }
    if (interrupted) {
      this.value.interrupted = true
      this.value.messages.push({ id: randomUUID(), role: 'activity', at: Date.now(), text: '上次任务因客户端退出而中断。已保留记录，请核实已完成的操作后重新发起任务；旧确认不会自动执行。' })
      this.value.messages = this.value.messages.slice(-1200)
    }
  }
  summary() { return { status: this.value.status, permissionMode: this.value.permissionMode, hasMessages: this.value.messages.some(message => message.role === 'user'), interrupted: !!this.value.interrupted } }
  state(): AiConversationState { return structuredClone(this.value) }
  private publish(): void { this.emit('change', this.value) }
  private message(role: AiMessage['role'], text: string, error = false, approval?: AiApprovalRecord): void {
    this.value.messages.push({ id: randomUUID(), role, text: this.clean(text).slice(0, 50000), at: Date.now(), error, ...(approval ? { approval } : {}) })
    if (this.value.messages.length > 1200) this.value.messages.splice(0, this.value.messages.length - 1200)
    this.publish()
  }
  async test(): Promise<string> {
    if (this.controller || this.testing) throw new Error('AI 正在处理请求，请稍后测试')
    this.testing = true
    try {
      await this.completion([{ role: 'user', content: '请简短回复：连接成功。' }], AbortSignal.timeout(30000), false)
      return 'AI 接口连接成功。请使用支持工具调用的模型进行服务器管理。'
    } finally { this.testing = false }
  }
  private async completion(messages: ChatMessage[], signal: AbortSignal, tools: typeof aiTools | false = aiTools): Promise<ChatMessage> {
    const { baseUrl, model } = this.configurationValue
    if (!baseUrl || !model) throw new Error('请先配置 AI 接口地址和模型')
    const key = this.key()
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(60000)])
    let response: Response
    try {
      response = await fetch(endpoint(baseUrl), { method: 'POST', redirect: 'error', signal: timeout,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ model, messages, ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}), stream: false }) })
    } catch {
      if (signal.aborted) throw new Error('AI 任务已停止')
      throw new Error('AI 接口连接失败或超时，请检查地址、网络与证书')
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`AI 接口返回 HTTP ${response.status}，请检查 API Key、模型名称和接口权限`) }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('AI 接口没有返回内容')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('AI 返回内容超过 2 MB，请缩小任务范围') }
        chunks.push(next.value)
      }
    } finally { reader.releaseLock() }
    let result: any
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')).choices?.[0]?.message } catch { throw new Error('AI 接口未返回有效的对话数据') }
    if (!result || (result.content != null && typeof result.content !== 'string') || (!result.content && !result.tool_calls?.length)) throw new Error('AI 接口响应格式不正确，请检查是否兼容工具调用')
    const calls = result.tool_calls
    if (calls !== undefined && (!Array.isArray(calls) || calls.length > 8 || new Set(calls.map((call: any) => call?.id)).size !== calls.length || calls.some((call: any) => typeof call?.id !== 'string' || call.id.length > 128 || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string' || call.function.arguments.length > 24000))) throw new Error('AI 工具调用格式不正确或数量过多')
    return { role: 'assistant', content: result.content ? this.clean(result.content) : null,
      ...(calls?.length ? { tool_calls: calls.map((call: ToolCall) => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } })) } : {}) }
  }
  send(text: string, ids: string[]): AiConversationState {
    this.requireUnlocked()
    if (this.controller || this.testing) throw new Error('请先完成或停止当前 AI 任务')
    if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('请输入 1–12000 字的任务说明')
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('手动限定范围时，最多选择 200 台本机服务器；不勾选则可检索全部本机服务器')
    if (!this.configurationValue.baseUrl || !this.configurationValue.model) throw new Error('请先配置 AI 接口地址和模型')
    const scopeIds = ids.length ? ids : this.connections.list().map(connection => connection.id)
    const scope = new Map(scopeIds.map(id => {
      const connection = this.connections.get(id)
      if (!connection) throw new Error('所选服务器已不存在，请刷新列表')
      return [id, connection.updatedAt] as const
    }))
    if ([...ids].sort().join(',') !== [...this.value.selectedIds].sort().join(',')) {
      this.history = []
      if (this.value.messages.length) this.message('activity', '服务器范围已变化，模型上下文已重新开始')
    }
    this.compactHistory()
    this.value.selectedIds = [...ids]
    this.value.scopeMode = ids.length ? 'selected' : 'all'
    this.value.scopeCount = scope.size
    this.createdThisTurn = 0
    this.value.status = 'running'
    this.value.modelCalls = 0
    this.value.interrupted = false
    this.value.maxModelCalls = this.configurationValue.maxModelCalls
    const controller = new AbortController()
    this.controller = controller
    this.message('user', text.trim())
    this.history.push({ role: 'user', content: this.clean(text.trim()) })
    void this.run(scope, controller)
    return this.state()
  }
  private target(id: unknown, scope: Map<string, number>): Connection {
    this.requireUnlocked()
    if (typeof id !== 'string' || !scope.has(id)) throw new Error('该服务器不在本轮可访问范围内；手动勾选时仅可访问选中的服务器')
    const current = this.connections.get(id)
    if (!current || current.updatedAt !== scope.get(id)) throw new Error('服务器已被其他操作修改或删除，请重新发起任务')
    return current
  }
  private destination(connection: Connection): string {
    return this.options.destination?.(connection) ?? `${connection.username}@${connection.host}:${connection.port}`
  }
  private async requestApproval(request: AiApprovalRequest): Promise<boolean> {
    const pending: AiApproval = { ...request, id: randomUUID(), expiresAt: Date.now() + (this.options.approvalTimeoutMs ?? 300000) }
    this.value.pending = pending
    this.value.status = 'approval'
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => finish('expired'), Math.max(1, pending.expiresAt - Date.now()))
      const finish = (outcome: Exclude<AiApprovalOutcome, 'pending'>) => {
        if (this.approval?.id !== pending.id) return
        clearTimeout(timer)
        const record = this.value.messages.find(message => message.approval?.id === pending.id)?.approval
        if (record) record.outcome = outcome
        this.approval = undefined
        this.value.pending = null
        this.value.status = 'running'
        this.publish()
        resolve(outcome === 'confirmed')
      }
      this.approval = { id: pending.id, resolve: finish, expiresAt: pending.expiresAt }
      this.message('approval', pending.kind === 'ssh' ? 'SSH 命令确认' : pending.kind === 'delete' ? '删除服务器资料' : pending.title, false, { ...pending, outcome: 'pending' })
    })
  }
  confirm(id: string, approved: boolean): boolean {
    this.requireUnlocked()
    if (typeof id !== 'string' || typeof approved !== 'boolean' || !this.approval || this.approval.id !== id || this.approval.expiresAt <= Date.now() || this.controller?.signal.aborted) return false
    this.approval.resolve(approved ? 'confirmed' : 'cancelled')
    return true
  }
  cancel(): boolean {
    if (!this.controller) return false
    this.controller.abort()
    this.approval?.resolve('stopped')
    return true
  }
  clear(): AiConversationState {
    if (this.controller) throw new Error('请先停止当前任务再清空对话')
    this.history = []
    this.value = { status: 'idle', messages: [], pending: null, selectedIds: [], scopeMode: 'all', scopeCount: 0, permissionMode: this.value.permissionMode, modelCalls: 0, maxModelCalls: this.configurationValue.maxModelCalls }
    this.publish()
    return this.state()
  }
  private async tool(call: ToolCall, scope: Map<string, number>, signal: AbortSignal, denied: Set<string>, unavailable: Map<string, string>): Promise<unknown> {
    signal.throwIfAborted()
    if (!this.allowed(call.function.name)) throw new Error('当前权限模式不允许该操作，请由用户切换权限模式后重新发起任务')
    const input = JSON.parse(call.function.arguments)
    if (call.function.name === 'ask_user') {
      const args = object(input, ['title', 'message'])
      if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 80 || /[\x00-\x1f\x7f]/.test(args.title) || typeof args.message !== 'string' || !args.message.trim() || args.message.length > 2000) throw new Error('请提供 1–80 字的确认标题和 1–2000 字的操作说明')
      const confirmed = await this.requestApproval({ kind: 'question', title: this.clean(args.title.trim()), message: this.clean(args.message.trim()) })
      signal.throwIfAborted()
      return { confirmed, ...(!confirmed ? { rejected: true, reason: '用户已取消或确认超时，本轮后续操作未执行' } : {}) }
    }
    if (call.function.name === 'list_servers') {
      const args = object(input, ['query', 'offset', 'limit'])
      if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) throw new Error('搜索条件须为不超过 500 字的文本')
      const offset = args.offset ?? 0, limit = args.limit ?? 50
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('分页参数不正确：offset 须为非负整数，limit 须为 1–100')
      const current = [...scope.keys()].map(id => this.connections.get(id)).filter((item): item is Connection => !!item)
      this.value.scopeCount = current.length
      const matches = current.filter(item => matchesConnection(item, args.query ?? ''))
      const servers: ReturnType<typeof publicServer>[] = []
      let size = 0
      for (const item of matches.slice(offset, offset + limit)) {
        const projected = publicServer(item), length = JSON.stringify(projected).length
        if (servers.length && size + length > 32000) break
        servers.push(projected); size += length
        // A new read refreshes this target's revision; mutations still reject later concurrent edits.
        scope.set(item.id, item.updatedAt)
      }
      const nextOffset = offset + servers.length < matches.length ? offset + servers.length : null
      return { servers, total: matches.length, offset, nextOffset, scope: this.value.scopeMode }
    }
    if (call.function.name === 'create_server') {
      const args = object(input, ['kind', 'name', 'host', 'port', 'username', 'group', 'tags', 'note'])
      if (this.createdThisTurn >= 200 || this.value.scopeMode === 'selected' && scope.size >= 200) throw new Error('本轮最多新增 200 台服务器；限定范围时最多包含 200 台，请在新任务中继续')
      for (const key of ['name', 'host', 'username']) if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 1024 || /[\0\r\n]/.test(args[key])) throw new Error('请提供有效的服务器名称、地址和登录账号')
      if (!['ssh', 'rdp'].includes(args.kind) || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('请提供 SSH / RDP 协议与有效端口')
      const changes: MetadataChanges = {}
      if (args.tags !== undefined && !Array.isArray(args.tags)) throw new Error('服务器标签必须为数组')
      if (args.tags !== undefined) changes.tags = { mode: args.tags.length ? 'replace' : 'clear', values: args.tags }
      for (const key of ['note', 'group'] as const) if (args[key] !== undefined) changes[key] = { mode: args[key] === '' ? 'clear' : 'replace', value: args[key] }
      const metadata = Object.keys(changes).length ? applyMetadataChanges({}, changes) : {}
      const connection = this.connections.save({ kind: args.kind, name: args.name, host: args.host, port: args.port, username: args.username.trim(), authMethod: 'password', ...metadata })
      scope.set(connection.id, connection.updatedAt)
      this.createdThisTurn++
      if (this.value.scopeMode === 'selected') this.value.selectedIds = [...scope.keys()]
      this.value.scopeCount = scope.size
      this.options.metadataChanged?.()
      return { created: publicServer(connection), hint: '仅新增本机连接资料，未创建远程机器。请用户在连接编辑器填写密码或选择公共凭据，AI 不接触凭据。' }
    }
    if (call.function.name === 'delete_server') {
      const args = object(input, ['server_id'])
      const connection = this.target(args.server_id, scope)
      const denialKey = 'delete:' + connection.id
      if (denied.has(denialKey)) return { rejected: true, reason: '用户已拒绝删除此服务器资料，不能重试' }
      const approved = await this.requestApproval({ kind: 'delete', serverId: connection.id, serverName: connection.name, destination: `${connection.host}:${connection.port}` })
      signal.throwIfAborted()
      if (!approved) { denied.add(denialKey); return { rejected: true, reason: '用户拒绝或确认超时，未删除服务器资料' } }
      this.target(connection.id, scope)
      this.connections.delete(connection.id)
      scope.delete(connection.id)
      if (this.value.scopeMode === 'selected') this.value.selectedIds = [...scope.keys()]
      this.value.scopeCount = scope.size
      this.options.metadataChanged?.()
      return { deleted: publicServer(connection), hint: '仅删除本机连接资料；远程服务器和其他配置保留。' }
    }
    if (call.function.name === 'update_metadata') {
      const args = object(input, ['server_ids', 'changes'])
      if (!Array.isArray(args.server_ids) || !args.server_ids.length || args.server_ids.length > 200) throw new Error('请选择要更新的服务器')
      const items = args.server_ids.map((id: unknown) => this.target(id, scope))
      this.connections.batchMetadata({ items: items.map((item: Connection) => ({ id: item.id, updatedAt: item.updatedAt })), changes: args.changes as MetadataChanges })
      for (const item of items) scope.set(item.id, this.connections.get(item.id)!.updatedAt)
      this.options.metadataChanged?.()
      return { updated: items.map((item: Connection) => publicServer(this.connections.get(item.id)!)) }
    }
    if (call.function.name === 'inspect_windows') {
      const args = object(input, ['server_id', 'topic'])
      const connection = this.target(args.server_id, scope)
      if (connection.kind !== 'rdp') throw new Error('Windows 查询仅支持 RDP Windows 连接；SSH Linux 请使用 inspect_linux')
      if (typeof args.topic !== 'string' || !Object.hasOwn(windowsQueries, args.topic)) throw new Error('请选择受支持的 Windows 只读查询')
      if (!this.options.inspectWindows) throw new Error('当前客户端未提供 Windows 查询，请更新客户端')
      if (unavailable.has(connection.id)) return { error: unavailable.get(connection.id), skipped: true }
      const destination = this.destination(connection)
      this.message('activity', `Windows 只读查询 · ${connection.name} · ${args.topic}（WMI）`)
      try {
        return await this.options.inspectWindows(connection, args.topic as WindowsTopic, signal, actualDestination => {
          signal.throwIfAborted()
          this.target(connection.id, scope)
          if (actualDestination !== destination || this.destination(connection) !== destination) throw new Error('服务器登录账号已变化，请重新发起任务')
        })
      } catch (error) {
        if ((error as { windowsUnavailable?: boolean })?.windowsUnavailable) unavailable.set(connection.id, this.clean(error instanceof Error ? error.message : 'Windows 管理通道不可用'))
        throw error
      }
    }
    if (!['inspect_linux', 'run_ssh'].includes(call.function.name)) throw new Error('不支持的 AI 工具；凭据读取和修改未开放')
    const query = call.function.name === 'inspect_linux'
    const args = object(input, query ? ['server_id', 'topic'] : ['server_id', 'command', 'reason'])
    const connection = this.target(args.server_id, scope)
    if (connection.kind !== 'ssh') throw new Error('该服务器是 RDP Windows 连接，请使用 inspect_windows 查询；不支持通过 RDP 执行 SSH 命令')
    let command: string
    const destination = this.destination(connection)
    if (query) {
      if (typeof args.topic !== 'string' || !Object.hasOwn(linuxQueries, args.topic)) throw new Error('请选择受支持的 Linux 只读查询')
      command = linuxQueries[args.topic as keyof typeof linuxQueries]
    } else {
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 8000 || /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(args.command) || typeof args.reason !== 'string' || args.reason.length > 2000) throw new Error('命令或操作说明格式不正确')
      command = args.command
      const key = connection.id + '\0' + command
      if (denied.has(key)) return { rejected: true, reason: '用户已拒绝该命令，不能重试' }
      const approved = await this.requestApproval({ kind: 'ssh', serverId: connection.id, serverName: connection.name, destination, command, reason: this.clean(args.reason) })
      signal.throwIfAborted()
      if (!approved) { denied.add(key); return { rejected: true, reason: '用户拒绝或确认超时，未执行任何命令' } }
      this.target(connection.id, scope)
      if (this.destination(connection) !== destination) throw new Error('服务器登录账号已变化，请重新发起任务并确认')
    }
    signal.throwIfAborted()
    this.message('activity', `${query ? '只读查询' : '已确认执行'} · ${connection.name}\n${command}`)
    return this.options.execute(connection, command, signal, actualDestination => {
      signal.throwIfAborted()
      this.target(connection.id, scope)
      if (actualDestination !== destination || this.destination(connection) !== destination) throw new Error('服务器登录账号已变化，请重新发起任务并确认')
    }, this.id)
  }
  private async run(scope: Map<string, number>, controller: AbortController): Promise<void> {
    const signal = controller.signal, denied = new Set<string>(), unavailable = new Map<string, string>()
    try {
      for (let round = 0; round < this.value.maxModelCalls; round++) {
        signal.throwIfAborted()
        this.requireUnlocked()
        this.compactHistory()
        const selected = [...scope.keys()].map(id => this.connections.get(id)).filter((item): item is Connection => !!item)
        const tools = aiTools.filter(tool => {
          const name = tool.function.name
          if (!this.allowed(name)) return false
          if (name === 'inspect_linux' || name === 'run_ssh') return selected.some(item => item.kind === 'ssh')
          if (name === 'inspect_windows') return selected.some(item => item.kind === 'rdp' && !unavailable.has(item.id))
          return true
        })
        const finalRequest = round === this.value.maxModelCalls - 1
        const mode = aiPermissionModes.find(mode => mode.value === this.value.permissionMode)!
        this.value.modelCalls = round + 1
        this.publish()
        const response = await this.completion([{ role: 'system', content: aiSystemPrompt + '\n当前权限：' + mode.label + '。' + mode.description + '\n本轮可访问范围：' + (this.value.scopeMode === 'all' ? `全部本机服务器（${selected.length} 台），通过 list_servers 检索和分页获取实际 ID。` : '仅手动勾选的服务器。ID 及类型：' + selected.map(item => item.id + '=' + item.kind).join(', ')) + (this.historyTrimmed ? '\n较早的部分查询上下文已省略，完整记录仍在对话中；不得猜测缺失的结果。' : '') + (finalRequest ? '\n这是本轮最后一次模型请求。仅根据已有结果总结已完成、未完成和建议，不要调用任何工具；缺少信息请如实说明。' : '') }, ...this.history], signal, finalRequest ? false : tools)
        signal.throwIfAborted()
        this.history.push(response)
        if (response.content) this.message('assistant', response.content)
        if (!response.tool_calls?.length) return
        if (finalRequest) {
          for (const call of response.tool_calls) this.history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ rejected: true, reason: '本轮已达到模型调用上限，未执行此操作' }) })
          this.message('assistant', `本轮已达到 ${this.value.maxModelCalls} 次模型调用上限，后续操作已暂停。可发送“继续”接着处理，或到 AI 配置调整上限。`)
          return
        }
        let questionCancelled = false
        for (const call of response.tool_calls) {
          let result: unknown
          try { result = questionCancelled ? { rejected: true, skipped: true, reason: '用户已取消本轮确认，未执行后续操作' } : await this.tool(call, scope, signal, denied, unavailable) }
          catch (error) { result = { error: signal.aborted ? '用户已停止任务，操作取消' : this.clean(error instanceof Error ? error.message : 'AI 工具执行失败') } }
          if (call.function.name === 'ask_user' && (result as any)?.rejected) questionCancelled = true
          const serialized = JSON.stringify(result, (_key, value) => typeof value === 'string' ? this.clean(value) : value)
          const contents = serialized.length <= 40000 ? serialized : JSON.stringify({ truncated: true, preview: serialized.slice(0, 36000), hint: '结果较长，已截断。请缩小查询范围，或用名称/标签筛选服务器后继续。' })
          this.history.push({ role: 'tool', tool_call_id: call.id, content: contents })
          if (!signal.aborted && !(result as any)?.skipped && (call.function.name !== 'ask_user' || (result as any)?.error)) {
            const output = result as any
            const labels: Record<string, string> = { list_servers: '已读取服务器资料', update_metadata: '已更新服务器资料', inspect_linux: 'Linux 查询结果', inspect_windows: 'Windows 查询结果', run_ssh: 'SSH 执行结果', create_server: '已新增服务器资料', delete_server: '已删除服务器资料' }
            let report = output?.error ? '操作未完成\n' + output.error : output?.rejected ? '操作未执行\n' + output.reason : labels[call.function.name] ?? '工具结果'
            if (!output?.error && !output?.rejected) {
              if (output?.created || output?.deleted) { const item = output.created ?? output.deleted; report += ` · ${item.name}\n${item.host}:${item.port}\n${output.hint}` }
              else if (Array.isArray(output?.servers)) report += ` · 本页 ${output.servers.length} 台 / 匹配 ${output.total} 台\n` + output.servers.map((item: any) => `${item.name} · ${item.host}:${item.port}`).join('\n') + (output.nextOffset !== null ? `\n还有后续结果，下页起点 ${output.nextOffset}` : '')
              else if (Array.isArray(output)) report += ` · ${output.length} 台\n` + output.map(item => `${item.name} · ${item.host}:${item.port}`).join('\n')
              else if (Array.isArray(output?.updated)) report += ` · ${output.updated.length} 台\n` + output.updated.map((item: any) => `${item.name}\n标签：${item.tags.join('、') || '无'}\n分组：${item.group || '未分组'}\n备注：${item.note || '无'}`).join('\n\n')
              else report += ` · 退出码 ${output?.code ?? '未知'}\n${output?.stdout ?? ''}${output?.stderr ? '\n' + output.stderr : ''}${output?.truncated ? '\n输出超过限制，已截断。' : ''}`
            }
            this.message('activity', report, !!output?.error || typeof output?.code === 'number' && output.code !== 0)
          }
        }
        if (questionCancelled) {
          const decision = [...this.value.messages].reverse().find(message => message.approval?.kind === 'question')?.approval
          this.message('assistant', decision?.outcome === 'expired' ? '确认已超时，本轮后续操作未执行。需要继续时，请重新发起任务。' : '已取消，本轮后续操作未执行。你可以调整要求后重新开始。')
          return
        }
      }
    } catch (error) {
      this.message('activity', signal.aborted ? '已停止任务。未确认的命令不会执行；已经执行的命令不会自动回滚。' : error instanceof Error ? error.message : 'AI 任务失败', !signal.aborted)
    } finally {
      this.approval?.resolve('stopped')
      if (this.controller === controller) {
        this.controller = undefined
        this.value.status = 'idle'
        this.value.pending = null
        this.publish()
      }
    }
  }
  dispose(): void { this.cancel(); this.removeAllListeners() }
}


export class AiService extends EventEmitter {
  private conversations = new Map<string, { session: AiConversation; title: string; unread: boolean; updatedAt: number; lastMessageId?: string }>()
  private activeId = ''
  private revision = 0
  private restored = false
  private restoring = false
  private storageError = ''
  private saveTimer?: ReturnType<typeof setTimeout>
  private disposing = false
  constructor(private directory: string, private connections: ConnectionStore, private vault: VaultService, private options: AiOptions) {
    super()
    this.createConversation()
  }
  private session(id?: string): AiConversation {
    this.restoreConversations()
    id ??= this.activeId
    const item = this.conversations.get(id)
    if (!item) throw new Error('对话已不存在，请重新选择')
    return item.session
  }
  private restoreConversations(): void {
    if (this.restored || this.restoring || !this.conversations.size || this.vault.status() !== 'unlocked') return
    this.restoring = true
    try {
      const path = join(this.directory, CONVERSATIONS_FILE)
      if (existsSync(path)) {
        const saved = JSON.parse(this.vault.openLocalData(readFileSync(path, 'utf8'), CONVERSATIONS_CONTEXT))
        if (saved.version !== 1 || !Array.isArray(saved.items) || !saved.items.length || saved.items.length > 30 || new Set(saved.items.map((item: any) => item.id)).size !== saved.items.length) throw new Error('对话记录格式不正确')
        const restored = saved.items.map((item: any) => {
          if (typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id) || typeof item.title !== 'string') throw new Error('对话记录格式不正确')
          const session = new AiConversation(this.directory, this.connections, this.vault, this.options, item.id)
          session.restore(item.snapshot)
          return { session, title: item.title.slice(0, 100), unread: !!item.unread, updatedAt: item.updatedAt, lastMessageId: session.state().messages.at(-1)?.id }
        })
        for (const { session } of this.conversations.values()) session.dispose()
        this.conversations.clear()
        for (const item of restored) this.attachConversation(item)
        this.activeId = this.conversations.has(saved.activeId) ? saved.activeId : restored[0].session.id
      }
      this.restored = true
    } catch {
      // Do not overwrite the user's original encrypted file after a failed restore.
      this.storageError = '本机加密对话记录读取失败，原文件已保留；请恢复匹配的保险箱和对话文件。当前新记录暂不写入该文件。'
      this.restored = true
    } finally { this.restoring = false }
  }
  private persist(): void {
    if (!this.restored || this.storageError || this.vault.status() !== 'unlocked') return
    try {
      const contents = JSON.stringify({ version: 1, activeId: this.activeId, items: [...this.conversations.values()].map(item => ({ id: item.session.id, title: item.title, unread: item.unread, updatedAt: item.updatedAt, snapshot: item.session.snapshot() })) })
      const path = join(this.directory, CONVERSATIONS_FILE)
      writeFileSync(path + '.tmp', this.vault.sealLocalData(contents, CONVERSATIONS_CONTEXT), { mode: 0o600 })
      renameSync(path + '.tmp', path)
    } catch { this.storageError = '本机对话记录保存失败，请检查数据目录的磁盘空间和写入权限。' }
  }
  private publish(): void {
    this.revision++
    this.emit('change', this.state())
    if (!this.disposing && !this.restoring) {
      clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => { this.persist(); if (this.storageError) { this.revision++; this.emit('change', this.state()) } }, 300)
      this.saveTimer.unref()
    }
  }
  private attachConversation(item: { session: AiConversation; title: string; unread: boolean; updatedAt: number; lastMessageId?: string }): void {
    const session = item.session
    this.conversations.set(session.id, item)
    session.on('change', (state: AiConversationState) => {
      const last = state.messages.at(-1)
      if (last?.id !== item.lastMessageId) {
        if (this.activeId !== session.id && last && ['assistant', 'approval'].includes(last.role)) item.unread = true
        item.lastMessageId = last?.id
        item.updatedAt = Date.now()
      }
      this.publish()
    })
  }
  configuration(): AiConfiguration { return this.session().configuration() }
  saveConfiguration(input: AiConfigurationInput): AiConfiguration {
    if ([...this.conversations.values()].some(item => item.session.busy())) throw new Error('请先完成或停止所有对话中的 AI 任务，再修改配置')
    const current = this.session(), result = current.saveConfiguration(input)
    for (const { session } of this.conversations.values()) if (session !== current) session.applyConfiguration(result)
    this.publish()
    return result
  }
  test(): Promise<string> {
    if ([...this.conversations.values()].some(item => item.session.busy())) throw new Error('AI 正在处理请求，请稍后测试')
    return this.session().test()
  }
  state(): AiState {
    this.restoreConversations()
    return { ...this.session().state(), ...(this.storageError ? { storageError: this.storageError } : {}), revision: this.revision, conversationId: this.activeId, conversations: [...this.conversations.entries()].map(([id, item]) => ({ id, title: item.title, ...item.session.summary(), unread: item.unread, updatedAt: item.updatedAt })) }
  }
  createConversation(): AiState {
    this.restoreConversations()
    if (this.conversations.size >= 30) throw new Error('最多保留 30 个对话，请删除不再需要的对话后新建')
    const session = new AiConversation(this.directory, this.connections, this.vault, this.options)
    const item = { session, title: '新对话', unread: false, updatedAt: Date.now(), lastMessageId: undefined as string | undefined }
    this.attachConversation(item)
    this.activeId = session.id
    this.publish()
    return this.state()
  }
  selectConversation(id: string): AiState {
    if (typeof id !== 'string') throw new Error('请选择有效的对话')
    this.session(id)
    this.activeId = id
    this.conversations.get(id)!.unread = false
    this.publish()
    return this.state()
  }
  deleteConversation(id: string): AiState {
    if (typeof id !== 'string') throw new Error('请选择有效的对话')
    const session = this.session(id)
    if (session.busy()) throw new Error('请先完成或停止此对话的任务，再删除对话')
    session.dispose()
    this.conversations.delete(id)
    if (!this.conversations.size) return this.createConversation()
    if (this.activeId === id) this.activeId = [...this.conversations.keys()].at(-1)!
    this.conversations.get(this.activeId)!.unread = false
    this.publish()
    return this.state()
  }
  setPermissionMode(mode: AiPermissionMode, id?: string): AiState { this.session(id).setPermissionMode(mode); return this.state() }
  send(text: string, ids: string[], id?: string): AiState {
    const session = this.session(id)
    session.send(text, ids)
    const item = this.conversations.get(session.id)!
    if (item.title === '新对话') item.title = text.trim().replace(/\s+/g, ' ').slice(0, 28)
    this.publish()
    return this.state()
  }
  confirm(id: string, approved: boolean, conversationId?: string): boolean { return this.session(conversationId).confirm(id, approved) }
  cancel(id?: string): boolean { return this.session(id).cancel() }
  cancelAll(): void { for (const { session } of this.conversations.values()) session.cancel(); this.persist() }
  clear(id?: string): AiState {
    const session = this.session(id)
    session.clear()
    this.conversations.get(session.id)!.title = '新对话'
    this.publish()
    return this.state()
  }
  dispose(): void { this.disposing = true; clearTimeout(this.saveTimer); for (const { session } of this.conversations.values()) session.dispose(); this.persist(); this.removeAllListeners() }
}
