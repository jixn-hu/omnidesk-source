import { backupOptions, BACKUP_LABELS, type BackupOptions, type BackupSection, type BackupPreferences } from '@shared/backup.js'
import { connectionKey, parseConnectionAddress } from '@shared/connection-identity.js'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { sharedConfiguration } from '@shared/shared-configuration.js'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Connection, Credential, SharedCredential, ConfigurationSummary } from '@shared/types.js'
import type { ConnectionStore } from './connection-store.js'
import type { SharedCredentialStore } from './shared-credentials.js'
import type { VaultService } from './vault.js'

const LIMIT = 16 * 1024 * 1024
const FILES = ['vault.enc', 'shared-credentials.json', 'connections.json'] as const
const JOURNAL = 'configuration-import-recovery.json'
const AAD = Buffer.from('OmniDesk encrypted configuration v1')
export type ConfirmConfiguration = (message: string, detail: string) => Promise<boolean>

interface Snapshot {
  version: 1
  connections: Connection[]
  sharedCredentials: SharedCredential[]
  credentials: Record<string, Credential>
  modules?: Partial<Record<BackupSection, unknown>>
}

export interface BackupModules {
  capture(options: BackupOptions): Partial<Record<BackupSection, unknown>>
  prepare(modules: Partial<Record<BackupSection, unknown>>, connectionIds: Map<string, string>): { files: Record<string, string>; credentials: Record<string, Credential>; removeRefs: string[]; commit(): void; preferences?: BackupPreferences; details?: string[] }
}

function keyFor(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== 'string' || password.length > 1024) throw new Error('备份密码格式不正确')
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置对象格式不正确')
  return value as Record<string, any>
}

function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${name}格式不正确`)
  return value
}

function identifier(value: unknown): string {
  const result = text(value, '配置标识', 128)
  if (!/^[A-Za-z0-9_.:-]+$/.test(result) || ['__proto__', 'constructor', 'prototype'].includes(result)) throw new Error('配置标识不合法')
  return result
}

function port(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) throw new Error('配置端口必须为 1–65535')
  return value as number
}

function validateSnapshot(input: unknown): Snapshot {
  const raw = object(input)
  if (raw.version !== 1 || !Array.isArray(raw.connections) || !Array.isArray(raw.sharedCredentials) || raw.connections.length > 10000 || raw.sharedCredentials.length > 10000) throw new Error('不支持的配置版本或记录数量过大')
  const credentials = Object.fromEntries(Object.entries(object(raw.credentials)).map(([ref, input]) => {
    identifier(ref)
    if (ref.startsWith('omnidesk-monitor-agent:') || ['webdav-sync-password', 'configuration-backup-password', 'official-account-session', 'omnidesk-ai-api-key', 'omnidesk-monitor-service'].includes(ref)) throw new Error('备份不能覆盖本机同步登录凭据')
    const value = object(input)
    const passphrase = value.passphrase ?? undefined
    if (typeof value.secret !== 'string' || value.secret.length > 1024 * 1024 || (passphrase !== undefined && typeof passphrase !== 'string')) throw new Error('凭据格式不正确')
    return [ref, { secret: value.secret, passphrase }]
  }))
  const ref = (value: unknown) => {
    if (value === undefined) return undefined
    const result = identifier(value)
    if (!Object.hasOwn(credentials, result)) throw new Error('备份中缺少引用的密码或私钥，请先修复原连接凭据')
    return result
  }
  const optionalText = (value: unknown, name: string) => value === undefined ? undefined : text(value, name)
  const note = (value: unknown) => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length > 16384 || value.includes('\0')) throw new Error('备注格式不正确')
    return value
  }
  const timestamps = (value: Record<string, any>) => ({ createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(), updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now() })
  const sharedCredentials = raw.sharedCredentials.map((input: unknown): SharedCredential => {
    const value = object(input)
    if (!['password', 'privateKey'].includes(value.kind)) throw new Error('公共凭据类型不正确')
    return { id: identifier(value.id), name: text(value.name, '公共凭据名称', 256), kind: value.kind, username: optionalText(value.username, '账号'), domain: optionalText(value.domain, '域'), note: note(value.note), credentialRef: ref(identifier(value.credentialRef))!, ...timestamps(value) }
  })
  const connections = raw.connections.map((input: unknown): Connection => {
    const value = object(input)
    if (!['ssh', 'rdp'].includes(value.kind)) throw new Error('连接协议不正确')
    const endpoint = { host: text(value.host, '主机地址', 1024), port: port(value.port) }
    parseConnectionAddress(endpoint.host, endpoint.port)
    const result = { id: identifier(value.id), kind: value.kind, name: text(value.name, '连接名称', 256), ...endpoint, username: text(value.username ?? '', '账号'), group: optionalText(value.group, '分组'), note: note(value.note), credentialRef: ref(value.credentialRef), sharedCredentialId: value.sharedCredentialId === undefined ? undefined : identifier(value.sharedCredentialId), exposedToExternal: false, ...timestamps(value) } as Connection
    if (!result.name.trim() || !result.host.trim()) throw new Error('连接名称和地址不能为空')
    if (result.sharedCredentialId && !sharedCredentials.some((item) => item.id === result.sharedCredentialId)) throw new Error('配置引用了不存在的公共凭据')
    if (value.tags !== undefined) {
      if (!Array.isArray(value.tags) || value.tags.length > 100) throw new Error('连接标签格式不正确')
      result.tags = value.tags.map((tag: unknown) => text(tag, '标签', 128))
    }
    if (value.proxy !== undefined) {
      const proxy = object(value.proxy)
      if (!['none', 'socks4', 'socks5', 'http'].includes(proxy.type)) throw new Error('代理类型不正确')
      result.proxy = { type: proxy.type, host: text(proxy.host, '代理地址'), port: proxy.type === 'none' ? 0 : port(proxy.port), username: optionalText(proxy.username, '代理账号'), password: optionalText(proxy.password, '代理密码') }
    }
    // Preserve legacy backup metadata; system VPN integration has been removed.
    if (value.vpn !== undefined) {
      const vpn = object(value.vpn)
      if (vpn.disconnectAfter !== undefined && typeof vpn.disconnectAfter !== 'boolean') throw new Error('VPN 配置不正确')
      result.vpn = { name: text(vpn.name, 'VPN 名称'), disconnectAfter: vpn.disconnectAfter }
    }
    if (result.kind === 'ssh') {
      if (!['password', 'privateKey', 'agent'].includes(value.authMethod)) throw new Error('SSH 认证类型不正确')
      result.authMethod = value.authMethod
      if (value.jump !== undefined) {
        const jump = object(value.jump)
        result.jump = { host: text(jump.host, '跳板地址'), port: port(jump.port), username: text(jump.username, '跳板账号'), credentialRef: ref(jump.credentialRef) }
      }
    } else {
      result.domain = optionalText(value.domain, '域')
      if (value.options !== undefined) {
        const options = object(value.options)
        result.options = {}
        if (options.engine !== undefined) {
          if (!['ironrdp', 'freerdp'].includes(options.engine)) throw new Error('RDP 引擎不正确')
          result.options.engine = options.engine
        }
        if (options.securityMode !== undefined) {
          if (!['auto', 'legacy'].includes(options.securityMode)) throw new Error('RDP 安全模式不正确')
          result.options.securityMode = options.securityMode
        }
        if (options.performanceMode !== undefined) {
          if (!['smooth', 'balanced', 'clear'].includes(options.performanceMode)) throw new Error('远程桌面画质模式不正确')
          result.options.performanceMode = options.performanceMode
        }
        for (const name of ['dynamicResolution', 'fullscreen', 'systemSmartSizing', 'enableClipboard', 'showWallpaper', 'fontSmoothing', 'desktopComposition', 'showDraggedWindow', 'showMenuAnimations', 'showThemes', 'showBlinkingCursor', 'ignoreCertificate'] as const) {
          if (options[name] !== undefined) {
            if (typeof options[name] !== 'boolean') throw new Error('远程桌面开关格式不正确')
            result.options[name] = options[name]
          }
        }
        if (options.audioCaptureMode !== undefined) {
          if (!['none', 'local', 'remote'].includes(options.audioCaptureMode)) throw new Error('音频配置不正确')
          result.options.audioCaptureMode = options.audioCaptureMode
        }
        if (options.colorDepth !== undefined) {
          if (![16, 24, 32].includes(options.colorDepth)) throw new Error('色深配置不正确')
          result.options.colorDepth = options.colorDepth
        }
      }
    }
    return result
  })
  for (const records of [connections, sharedCredentials]) {
    if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error('配置包含重复标识')
  }
  let modules: Snapshot['modules']
  if (raw.modules !== undefined) {
    modules = object(raw.modules)
    if (Object.keys(modules).some(key => !Object.hasOwn(BACKUP_LABELS, key))) throw new Error('备份包含不支持的内容分区，请更新客户端后重试')
  }
  return { version: 1, connections, sharedCredentials, credentials, ...(modules ? { modules } : {}) }
}

export function writeConfigurationFile(path: string, contents: string | Buffer): void {
  writeFileSync(`${path}.tmp`, contents, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

export function recoverConfigurationImport(directory: string): void {
  const journal = join(directory, JOURNAL)
  if (!existsSync(journal)) return
  const saved = object(JSON.parse(readFileSync(journal, 'utf8')))
  for (const name of Object.keys(saved)) {
    if (![...FILES, 'webdav-sync.json', 'official-account.json', 'ai-settings.json', 'ai-conversations.enc', 'monitoring.json', 'backup-preferences.json'].includes(name)) throw new Error('配置恢复文件名不合法，未修改数据')
    if (saved[name] !== null && typeof saved[name] !== 'string') throw new Error('配置恢复记录损坏，请保留数据目录并恢复备份')
    const path = join(directory, name)
    if (saved[name] === null) { if (existsSync(path)) unlinkSync(path) }
    else {
      const original = Buffer.from(saved[name], 'base64')
      if (!existsSync(path) || !readFileSync(path).equals(original)) writeConfigurationFile(path, original)
    }
  }
  unlinkSync(journal)
}

export function writeConfigurationTransaction(directory: string, files: Record<string, string>): void {
  const names = Object.keys(files)
  if (!names.length || names.some((name) => ![...FILES, 'webdav-sync.json', 'official-account.json', 'ai-settings.json', 'ai-conversations.enc', 'monitoring.json', 'backup-preferences.json'].includes(name))) throw new Error('配置事务文件不合法')
  const journal = join(directory, JOURNAL)
  if (existsSync(journal)) throw new Error('存在未恢复的配置操作，请重启应用后再试')
  const originals = Object.fromEntries(names.map((name) => [name, existsSync(join(directory, name)) ? readFileSync(join(directory, name)).toString('base64') : null]))
  writeConfigurationFile(journal, JSON.stringify(originals))
  try {
    for (const name of names) writeConfigurationFile(join(directory, name), files[name])
    unlinkSync(journal)
  } catch (error) {
    recoverConfigurationImport(directory)
    throw error
  }
}

export class ConfigurationBackupService {
  private busy = false
  modules?: BackupModules
  onRestored?: (summary: ConfigurationSummary) => void

  constructor(private readonly directory: string, private readonly connections: ConnectionStore, private readonly shared: SharedCredentialStore, private readonly vault: VaultService, private readonly confirm: ConfirmConfiguration) {}

  private fileState(): string {
    return JSON.stringify(['vault.enc', 'connections.json', 'shared-credentials.json', 'monitoring.json', 'ai-settings.json', 'backup-preferences.json'].map(name => {
      const path = join(this.directory, name)
      return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
    }))
  }

  hasSavedPassword(): boolean {
    return this.vault.status() === 'unlocked' && !!this.vault.getCredential('configuration-backup-password')?.secret
  }

  async importSharedConnection(input: unknown): Promise<{ connectionId: string; skipped: boolean } | null> {
    if (this.busy) throw new Error('已有配置导入进行中，请稍后重试')
    this.busy = true
    try {
      if (this.vault.status() !== 'unlocked') throw new Error('请先解锁保险箱')
      const payload = object(input)
      const configuration = sharedConfiguration(payload.configuration)
      parseConnectionAddress(configuration.host, configuration.port)
      const duplicate = this.connections.list().find(record => connectionKey(record) === connectionKey(configuration))
      if (duplicate) return { connectionId: duplicate.id, skipped: true }
      const connectionId = randomUUID()
      const credentialRef = 'shared-copy-' + randomUUID()
      const snapshot = validateSnapshot({ version: 1, connections: [{ ...configuration, id: connectionId, credentialRef, exposedToExternal: false, createdAt: Date.now(), updatedAt: Date.now() }], sharedCredentials: [], credentials: { [credentialRef]: payload.credential } })
      if (!await this.confirm('下载为本地独立连接？', `「${configuration.name}」的配置及密码 / 私钥将保存到本机保险箱。\n\n下载后可像自己新增的连接一样编辑、连接、导出；修改与撤销共享不会覆盖或删除这份本地副本。请确认信任共享者，首次 SSH 连接仍需核对主机指纹。`)) return null
      if (this.vault.status() !== 'unlocked') throw new Error('保险箱已锁定，未修改配置')
      const previous = this.connections.list()
      const currentDuplicate = previous.find(record => connectionKey(record) === connectionKey(configuration))
      if (currentDuplicate) return { connectionId: currentDuplicate.id, skipped: true }
      const prepared = this.vault.prepareCredentialImport(snapshot.credentials)
      writeConfigurationTransaction(this.directory, { 'vault.enc': prepared.contents, 'connections.json': JSON.stringify({ version: 1, connections: [...previous, ...snapshot.connections] }) })
      prepared.commit()
      this.connections.reload()
      return { connectionId, skipped: false }
    } finally { this.busy = false }
  }

  savePassword(password: string): boolean {
    if (typeof password !== 'string' || password.length > 4096) throw new Error('备份密码格式不正确')
    if (password) this.vault.setCredential('configuration-backup-password', password)
    else this.vault.deleteCredential('configuration-backup-password')
    return this.hasSavedPassword()
  }

  private password(input: string): string {
    const password = input || this.vault.getCredential('configuration-backup-password')?.secret
    if (typeof password !== 'string' || !password.length) throw new Error('请输入备份加密密码，或先在本机记住密码')
    if (password.length > 4096) throw new Error('备份密码过长')
    return password
  }

  async create(password: string, input?: BackupOptions): Promise<string> {
    password = this.password(password)
    if (this.vault.status() !== 'unlocked') throw new Error('请先解锁保险箱，再备份密码和私钥')
    const options = backupOptions(input)
    const connections = this.connections.list()
    const sharedCredentials = this.shared.list()
    const refs = new Set([...connections.flatMap((record) => [record.credentialRef, record.kind === 'ssh' ? record.jump?.credentialRef : undefined]), ...sharedCredentials.map((record) => record.credentialRef)].filter((ref): ref is string => !!ref))
    const credentials = Object.fromEntries([...refs].map((ref) => [ref, this.vault.getCredential(ref)]))
    const snapshot = validateSnapshot({ version: 1, connections, sharedCredentials, credentials })
    if (options.sections.length && !this.modules) throw new Error('扩展备份服务尚未就绪')
    if (options.sections.length) snapshot.modules = this.modules!.capture(options)
    const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8')
    if (plaintext.length > LIMIT / 2) throw new Error('所选备份内容超过 8MB，请减少记录、私钥或取消勾选 AI 对话记录后重试')
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const key = await keyFor(password, salt)
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(AAD)
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return JSON.stringify({ format: 'omnidesk-encrypted-configuration', version: 1, kdf: 'scrypt-32768-8-1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
    } finally { key.fill(0); plaintext.fill(0) }
  }

  async restore(contents: string, password: string, input?: BackupOptions): Promise<ConfigurationSummary | null> {
    if (this.busy) throw new Error('已有配置导入进行中，请稍后重试')
    this.busy = true
    try {
      if (this.vault.status() !== 'unlocked') throw new Error('请先解锁保险箱，再导入配置')
      const options = backupOptions(input)
      if (Buffer.byteLength(contents) > LIMIT) throw new Error('配置文件过大')
      const box = object(JSON.parse(contents.replace(/^\uFEFF/, '')))
      if (box.format !== 'omnidesk-encrypted-configuration' || box.version !== 1 || box.kdf !== 'scrypt-32768-8-1') throw new Error('不是支持的 OmniDesk 加密备份；XTerminal 配置请使用专用导入入口')
      const decode = (value: unknown, length?: number) => {
        if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('加密备份格式不正确')
        const bytes = Buffer.from(value, 'base64')
        if (length && bytes.length !== length) throw new Error('加密参数不正确')
        return bytes
      }
      const key = await keyFor(this.password(password), decode(box.salt, 16))
      let snapshot: Snapshot
      let plaintext: Buffer | undefined
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, decode(box.iv, 12))
        decipher.setAAD(AAD)
        decipher.setAuthTag(decode(box.tag, 16))
        try { plaintext = Buffer.concat([decipher.update(decode(box.data)), decipher.final()]) }
        catch { throw new Error('备份密码错误，或文件已损坏 / 被篡改；未修改本地配置') }
        snapshot = validateSnapshot(JSON.parse(plaintext.toString('utf8')))
      } finally { key.fill(0); plaintext?.fill(0) }
      const previous = this.connections.list()
      const endpoints = new Map(previous.map(record => [connectionKey(record), record.id]))
      const importedConnections = snapshot.connections.filter(record => {
        if (previous.some(item => item.id === record.id && connectionKey(item) === connectionKey(record))) return true
        const owner = endpoints.get(connectionKey(record))
        if (owner && owner !== record.id) return false
        const prior = previous.find(item => item.id === record.id)
        if (prior && endpoints.get(connectionKey(prior)) === record.id) endpoints.delete(connectionKey(prior))
        endpoints.set(connectionKey(record), record.id)
        return true
      })
      const skipped = snapshot.connections.length - importedConnections.length
      const connectionIds = new Map(snapshot.connections.map(record => [record.id, importedConnections.some(item => item.id === record.id) ? record.id : endpoints.get(connectionKey(record))!]))
      const selected = Object.fromEntries(options.sections.filter(section => Object.hasOwn(snapshot.modules ?? {}, section)).map(section => [section, snapshot.modules![section]]))
      const sections = Object.keys(selected) as BackupSection[]
      if (sections.length && !this.modules) throw new Error('扩展备份服务尚未就绪')
      const prepareModules = () => sections.length ? this.modules!.prepare(selected, connectionIds) : undefined
      let extra = prepareModules()
      const before = this.fileState()
      const summary: ConfigurationSummary = { sections, ...(extra?.preferences ? { preferences: extra.preferences } : {}), connections: importedConnections.length, sharedCredentials: snapshot.sharedCredentials.length, skipped }
      if (!await this.confirm('导入加密配置？', `包含 ${summary.connections} 条连接、${summary.sharedCredentials} 条公共凭据及其密码 / 私钥。\n可选内容：${sections.map(section => BACKUP_LABELS[section]).join('、') || '无（旧备份或未选择）'}。${extra?.details?.length ? '\n' + extra.details.join('\n') : ''}\n未选择的本机设置保持不变；AI 对话按 ID 合并，待确认操作不会执行。\n\n同 ID 记录将更新；发现的 ${skipped} 条不同 ID、相同服务器连接将跳过，本地其他连接不会删除；已建立的会话不受影响。导入记录的外部访问授权关闭，主机指纹仍需本机确认。`)) return null
      if (this.vault.status() !== 'unlocked') throw new Error('保险箱已锁定，未修改配置')
      if (this.fileState() !== before) throw new Error('确认期间本机配置发生变化，请重新导入；未修改配置')
      extra = prepareModules()
      if (snapshot.connections.some((record) => previous.some((local) => local.id === record.id && local.kind !== record.kind))) throw new Error('连接 ID 与本地不同协议的连接冲突，未导入')
      const merge = <RecordType extends { id: string }>(local: RecordType[], imported: RecordType[]) => [...new Map([...local, ...imported].map((record) => [record.id, record])).values()]
      const prepared = this.vault.prepareCredentialImport({ ...snapshot.credentials, ...extra?.credentials }, extra?.removeRefs)
      const files = { ...extra?.files, 'vault.enc': prepared.contents, 'shared-credentials.json': JSON.stringify({ version: 1, credentials: merge(this.shared.list(), snapshot.sharedCredentials) }), 'connections.json': JSON.stringify({ version: 1, connections: merge(previous, importedConnections) }) }
      writeConfigurationTransaction(this.directory, files)
      prepared.commit()
      this.connections.reload()
      this.shared.reload()
      extra?.commit()
      this.onRestored?.(summary)
      return summary
    } finally { this.busy = false }
  }
}
