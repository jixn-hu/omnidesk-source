import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectionKey } from '@shared/connection-identity.js'
import type { Connection, Credential, ImportCandidate, ImportScanResult, RdpConnection, SshConnection } from '@shared/types.js'

interface XtRecord {
  _id?: string
  title?: string
  note?: string
  host?: string
  port?: number
  username?: string
  password?: string | { username?: string; password?: string }
  privateKey?: string | { username?: string; privateKey?: string; passphrase?: string }
  passphrase?: string
  authType?: string
  type?: string
  groupId?: string
  identityId?: string
  isReady?: boolean
  errors?: unknown[]
  authDecrypted?: { address?: string; port?: number; username?: string; password?: string; domain?: string }
}
interface XtGroup { _id?: string; name?: string; parentId?: string | null }
const scans = new Map<string, { expires: number; credentials: Map<string, Credential> }>()

export function createImportScan(credentials: Map<string, Credential>): string {
  const scanId = randomUUID()
  for (const [id, scan] of scans) if (scan.expires < Date.now()) scans.delete(id)
  while (scans.size >= 5) scans.delete(scans.keys().next().value!)
  scans.set(scanId, { expires: Date.now() + 15 * 60_000, credentials })
  return scanId
}

export function takeImportCredential(scanId: string, tempId: string): Credential | undefined {
  const scan = scans.get(scanId)
  if (!scan || scan.expires < Date.now()) {
    scans.delete(scanId)
    throw new Error('导入预览已过期，请重新扫描')
  }
  return scan.credentials.get(tempId)
}

export function locateXTerminalDb(): string | null {
  const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  const candidates = ['xterminal', 'XTerminal', 'xTerminal'].map(name => join(appData, name, 'sqlite', 'local-store.db'))
  if (process.env['LOCALAPPDATA']) {
    for (const name of ['XTerminal', 'xterminal']) candidates.push(join(process.env['LOCALAPPDATA'], 'Programs', name, 'sqlite', 'local-store.db'))
  }
  return candidates.find(path => { try { return existsSync(path) && statSync(path).isFile() } catch { return false } }) ?? null
}

export function scanXTerminal(dbPath: string, existing: Connection[]): ImportScanResult {
  const sqlite = require('node:sqlite') as typeof import('node:sqlite')
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  const rowsOf = <RecordType>(fragment: string): RecordType[] =>
    db.prepare('SELECT payload FROM local_store WHERE store_key LIKE ?').all('%' + fragment + '%')
      .flatMap(row => { try { return [JSON.parse(String(row.payload)) as RecordType] } catch { return [] } })
  let sshRecords: XtRecord[], rdpRecords: XtRecord[], identities: XtRecord[], groups: XtGroup[]
  try {
    sshRecords = rowsOf<XtRecord>('ServerDatabaseServerImp')
    rdpRecords = rowsOf<XtRecord>('RdpDatabaseServerImp')
    identities = rowsOf<XtRecord>('IdentityDatabaseServerImp')
    groups = rowsOf<XtGroup>('GroupDatabaseServerImp')
  } finally { db.close() }
  const { credentials, ...parsed } = parseXTerminalRecords({ sshRecords, rdpRecords, identities, groups }, existing)
  return { ...parsed, scanId: createImportScan(credentials), dbPath, dataDir: join(dbPath, '..', '..'), modifiedAt: statSync(dbPath).mtimeMs }
}

/** Shared by the PC scanner and Web upload importer; no filesystem or credential cache. */
export function parseXTerminalRecords({ sshRecords, rdpRecords, identities, groups }: {
  sshRecords: XtRecord[]; rdpRecords: XtRecord[]; identities: XtRecord[]; groups: XtGroup[]
}, existing: Connection[] = []) {
  const groupName = buildGroupNamer(groups)
  const existingKeys = new Set(existing.map(connectionKey))
  const credentials = new Map<string, Credential>()
  const candidates: ImportCandidate[] = []
  let missingCredentials = 0
  for (const kind of ['ssh', 'rdp'] as const) {
    for (const record of kind === 'ssh' ? sshRecords : rdpRecords) {
      const identity = record.authType === 'identity' ? identities.find(item => item._id === record.identityId) : undefined
      const source = record.authType === 'identity' ? identity : record
      const usable = !!source && source.isReady === true && !source.errors?.length
      const auth = kind === 'rdp' && !record.errors?.length ? record.authDecrypted : undefined
      const passwordInfo = typeof source?.password === 'object' ? source.password : undefined
      const keyInfo = typeof source?.privateKey === 'object' ? source.privateKey : undefined
      const isKey = source?.authType === 'privateKey' || /PRIVATE.?KEY/i.test(source?.type ?? '')
      const rawHost = kind === 'rdp' ? auth?.address : record.host
      const inferred = !rawHost ? extractHostFromTitle(record.title ?? '') : null
      const host = String(rawHost || inferred || '').trim()
      const portInTitle = !rawHost ? /:(\d{1,5})(?:\s|$)/.exec(record.title ?? '')?.[1] : undefined
      const port = Number(kind === 'rdp' ? auth?.port ?? portInTitle : record.port) || (kind === 'rdp' ? 3389 : 22)
      const username = String(auth?.username ?? ((usable ? passwordInfo?.username || keyInfo?.username : undefined) || record.username || '')).trim()
      const tempId = randomUUID()
      let credential: Credential | undefined
      if (kind === 'rdp' && typeof auth?.password === 'string' && auth.password) credential = { secret: auth.password }
      else if (kind === 'ssh' && usable) {
        const secret = isKey ? (keyInfo?.privateKey ?? source.privateKey) : (passwordInfo?.password ?? source.password)
        if (typeof secret === 'string' && secret) credential = { secret, passphrase: isKey ? keyInfo?.passphrase ?? source.passphrase : undefined }
      }
      if (credential) credentials.set(tempId, credential)
      else missingCredentials++
      const key = connectionKey({ kind, host, port })
      const duplicate = !!host && existingKeys.has(key)
      if (host) existingKeys.add(key)
      candidates.push({ tempId, kind, name: String(record.title || host).trim(), host, port, username,
        domain: auth?.domain, authMethod: isKey ? 'privateKey' : 'password',
        credentialAvailable: !!credential, group: record.groupId ? groupName(record.groupId) : undefined,
        note: typeof record.note === 'string' ? record.note : undefined, hostInferred: !!inferred,
        usernameMissing: !username, sourceTitle: record.title ?? '', duplicate })
    }
  }
  const warnings: string[] = []
  if (missingCredentials) warnings.push(`${missingCredentials} 条连接未读取到密码或私钥。请先在 XTerminal 解锁仓库并保存，再重新扫描；仍不可读的项可先导入连接信息。`)
  if (candidates.some(item => item.hostInferred)) warnings.push('标黄地址由名称推断，请核对后勾选。')
  return { candidates, credentials,
    summary: { sshTotal: sshRecords.length, rdpTotal: rdpRecords.length, groups: groups.length,
      encryptedCredentials: missingCredentials, duplicates: candidates.filter(item => item.duplicate).length },
    warnings }
}

export function extractHostFromTitle(title: string): string | null {
  const t = title.trim()
  if (!t) return null

  // 去掉常见的装饰性前后缀
  const cleaned = t.replace(/^[\s[【(（]+|[\s\]】)）]+$/g, '')

  // IPv4，可能带端口
  const ipv4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d{1,5}))?$/.exec(cleaned)
  if (ipv4) {
    const octets = ipv4[1]!.split('.').map(Number)
    if (octets.every((o) => o >= 0 && o <= 255)) return ipv4[1]!
  }

  // 主机名：字母开头，含点，允许连字符；必须有点才认为像域名
  const hostname = /^([a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+)(?::(\d{1,5}))?$/.exec(cleaned)
  if (hostname) return hostname[1]!

  // 形如 "192.0.2.10 - 描述" 或 "描述 192.0.2.10"（192.0.2.x 是文档专用段，
  // 不会与任何真实内网地址冲突 —— 这里绝不能出现从用户数据里带来的真实地址）
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(cleaned)
  if (embedded) {
    const octets = embedded[1]!.split('.').map(Number)
    if (octets.every((o) => o >= 0 && o <= 255)) return embedded[1]!
  }

  return null
}

/** 构造分组名解析函数，把 parentId 链拼成「父 / 子」形式 */
function buildGroupNamer(groups: XtGroup[]): (id: string) => string | undefined {
  const byId = new Map<string, XtGroup>()
  for (const g of groups) {
    if (g._id) byId.set(g._id, g)
  }

  const resolve = (id: string, depth = 0): string | null => {
    if (depth > 8) return null // 防环
    const g = byId.get(id)
    if (!g?.name) return null
    if (!g.parentId) return g.name
    const parent = resolve(g.parentId, depth + 1)
    return parent ? `${parent} / ${g.name}` : g.name
  }

  return (id: string) => resolve(id) ?? undefined
}

/** 把候选项转成 OmniDesk 的连接对象 */
export function candidateToConnection(c: ImportCandidate): Connection {
  const now = Date.now()
  if (c.kind === 'ssh') {
    const conn: SshConnection = {
      id: '',
      kind: 'ssh',
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      authMethod: c.authMethod ?? 'password',
      group: c.group,
      note: c.note,
      exposedToExternal: false,
      createdAt: now,
      updatedAt: now
    }
    return conn
  }

  const conn: RdpConnection = {
    id: '',
    kind: 'rdp',
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    domain: c.domain,
    group: c.group,
    note: c.note,
    exposedToExternal: false,
    options: {
      dynamicResolution: true,
      enableClipboard: true,
      ignoreCertificate: true,
      ...c.rdpOptions
    },
    createdAt: now,
    updatedAt: now
  }
  return conn
}
