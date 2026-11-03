import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectionKey } from '@shared/connection-identity.js'
import type { Connection, Credential, ImportCandidate, ImportScanResult, RdpOptions } from '@shared/types.js'
import { createImportScan } from './xt-import.js'
import { decodeNrbf, dereferenceNrbf, isNrbfObject, type NrbfObject, type NrbfValue } from './rdo-nrbf.js'
import { decryptRdoPassword } from './rdo-password.js'

export function parseRdo(bytes: Buffer, existing: Connection[] = []): {
  candidates: ImportCandidate[]; credentials: Map<string, Credential>; groups: number; warnings: string[]
} {
  const decoded = decodeNrbf(bytes)
  if (decoded.consumed !== bytes.length || !isNrbfObject(decoded.root) || decoded.root.type !== 'RDO.Data.Types.Root') {
    throw new Error('不是受支持的 Remote Desktop Organizer 配置文件')
  }
  const resolve = (value: NrbfValue | undefined) => dereferenceNrbf(value, decoded.objects)
  const member = (object: NrbfObject, name: string) => resolve(object.members.get(name))
  const text = (object: NrbfObject, name: string): string => {
    const value = member(object, name)
    return typeof value === 'string' ? value : ''
  }
  const items = (value: NrbfValue | undefined): NrbfValue[] => {
    const object = resolve(value)
    if (Array.isArray(object)) return object
    if (!isNrbfObject(object) || object.type !== 'System.Collections.ArrayList') throw new Error('RDO 节点列表格式不受支持')
    const entries = member(object, '_items')
    const size = member(object, '_size')
    if (!Array.isArray(entries) || typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > entries.length) {
      throw new Error('RDO 节点列表已损坏')
    }
    return entries.slice(0, size)
  }
  const guid = (value: NrbfValue | undefined): string | undefined => {
    const object = resolve(value)
    if (typeof object === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(object)) return object.toLowerCase().replaceAll('-', '')
    if (!isNrbfObject(object) || object.type !== 'System.Guid') return undefined
    const names = ['_a', '_b', '_c', '_d', '_e', '_f', '_g', '_h', '_i', '_j', '_k']
    const values = names.map(name => member(object, name))
    if (values.some(value => typeof value !== 'number' || !Number.isInteger(value))) return undefined
    return (values as number[]).map((value, index) => (index === 0 ? value >>> 0 : value & (index < 3 ? 65535 : 255))
      .toString(16).padStart(index === 0 ? 8 : index < 3 ? 4 : 2, '0')).join('')
  }
  const identities = new Map<string, NrbfObject>()
  const sections = items(decoded.root.members.get('Nodes')).map(resolve)
  for (const section of sections) {
    if (!isNrbfObject(section) || section.type !== 'RDO.Data.Types.IdCards') continue
    for (const entry of items(section.members.get('Nodes')).map(resolve)) {
      if (!isNrbfObject(entry) || entry.type !== 'RDO.Data.Types.IdCard') continue
      const id = guid(entry.members.get('ID'))
      if (id && identities.has(id)) throw new Error('RDO 中存在重复的身份卡标识，请先在原软件整理后导入')
      if (id) identities.set(id, entry)
    }
  }

  const candidates: ImportCandidate[] = []
  const credentials = new Map<string, Credential>()
  const known = new Set(existing.map(connectionKey))
  const visited = new Set<NrbfObject>()
  const secrets = new Map<string, string | undefined>()
  let groups = 0
  let missingIdentities = 0
  let unreadablePasswords = 0
  let gatewayConnections = 0
  let credsspDisabled = 0
  const visit = (value: NrbfValue | undefined, path: string[], depth: number): void => {
    const object = resolve(value)
    if (!isNrbfObject(object) || depth > 32 || visited.has(object)) throw new Error('RDO 目录结构无效或存在循环引用')
    visited.add(object)
    if (object.type === 'RDO.Data.Types.Folder' || object.type === 'RDO.Data.Types.Connections') {
      const nextPath = object.type.endsWith('.Folder') ? [...path, text(object, 'Text').trim() || '未命名分组'] : path
      if (object.type.endsWith('.Folder')) groups++
      for (const child of items(object.members.get('Nodes'))) visit(child, nextPath, depth + 1)
      return
    }
    if (object.type !== 'RDO.Data.Types.RemoteDesktop') throw new Error('RDO 包含暂不支持的连接类型')
    if (candidates.length >= 10000) throw new Error('RDO 连接数量超过导入上限')
    const useIdentity = member(object, 'UseIdCard') === true
    const identityId = guid(object.members.get('IdCardGuid'))
    const identity = useIdentity && identityId ? identities.get(identityId) : undefined
    if (useIdentity && !identity) missingIdentities++
    const source = useIdentity ? identity : object
    const username = source ? text(source, 'User').trim() : ''
    const encrypted = source ? text(source, 'Password') : ''
    if (encrypted && !secrets.has(encrypted)) secrets.set(encrypted, decryptRdoPassword(encrypted))
    const secret = secrets.get(encrypted)
    if (encrypted && !secret) unreadablePasswords++
    const host = text(object, 'Host').trim()
    const rawPort = member(object, 'Port')
    const port = rawPort === undefined || rawPort === null ? 3389 : typeof rawPort === 'number' ? rawPort : Number(rawPort)
    const invalidPort = !Number.isInteger(port) || port < 1 || port > 65535
    const gateway = member(object, 'GatewayUsage')
    const needsGateway = gateway !== undefined && gateway !== null && gateway !== 0
    if (needsGateway) gatewayConnections++
    if (member(object, 'EnableCredSspSupport') === false) credsspDisabled++
    const options: RdpOptions = { dynamicResolution: true, enableClipboard: true, ignoreCertificate: true }
    const switches = [['SmartSize', 'systemSmartSizing'], ['AllowWallpaper', 'showWallpaper'], ['AllowContents', 'showDraggedWindow'],
      ['AllowAnimation', 'showMenuAnimations'], ['AllowThemes', 'showThemes']] as const
    for (const [sourceName, targetName] of switches) {
      const setting = member(object, sourceName)
      if (typeof setting === 'boolean') options[targetName] = setting
    }
    const colorDepth = member(object, 'ColorDepth')
    if (colorDepth === 16 || colorDepth === 24 || colorDepth === 32) options.colorDepth = colorDepth
    const audio = member(object, 'AudioSetting')
    if (audio === 0 || audio === 1 || audio === 2) options.audioCaptureMode = audio === 0 ? 'local' : audio === 1 ? 'remote' : 'none'
    const authentication = member(object, 'AuthenticationLevel')
    if (authentication === 1 || authentication === 2) options.ignoreCertificate = false
    const tempId = randomUUID()
    if (secret) credentials.set(tempId, { secret })
    const duplicate = !!host && known.has(connectionKey({ kind: 'rdp', host, port }))
    if (host) known.add(connectionKey({ kind: 'rdp', host, port }))
    candidates.push({ tempId, kind: 'rdp', name: text(object, 'Text').trim() || host || '未命名连接', host, port,
      username, domain: text(object, 'Domain').trim() || undefined, group: path.join(' / ') || undefined,
      note: text(object, 'Description') || undefined, credentialAvailable: !!secret, authMethod: 'password',
      credentialName: identity ? text(identity, 'Text') || undefined : undefined,
      requiresReview: needsGateway || invalidPort, reviewReason: needsGateway ? '源配置使用 RD Gateway，网关配置未迁移，请核对连接路径' : invalidPort ? '源配置端口无效，请修正' : undefined,
      rdpOptions: options, hostInferred: false, usernameMissing: !username, sourceTitle: text(object, 'Text'), duplicate })
  }
  const connectionSections = sections.filter(section => isNrbfObject(section) && section.type === 'RDO.Data.Types.Connections')
  if (!connectionSections.length) throw new Error('RDO 文件中没有找到连接列表')
  for (const section of connectionSections) visit(section, [], 0)
  const warnings: string[] = []
  if (unreadablePasswords) warnings.push(`${unreadablePasswords} 条连接的密码格式无法解密，未将密文当作密码导入；可导入配置后补填或选择公共凭据。`)
  if (missingIdentities) warnings.push(`${missingIdentities} 条连接引用的身份卡不存在，账号及密码需补充。`)
  if (gatewayConnections) warnings.push(`${gatewayConnections} 条连接使用 RD Gateway，网关配置暂不迁移；这些连接默认不勾选，请核对后再导入。`)
  if (credsspDisabled) warnings.push(`${credsspDisabled} 条源配置关闭了 CredSSP。不会照搬安全降级设置；导入配置不等于内置 RDP 已兼容旧版安全层，必要时请使用系统客户端。`)
  return { candidates, credentials, groups, warnings }
}

export function scanRdo(filePath: string, existing: Connection[]): ImportScanResult {
  if (extname(filePath).toLowerCase() !== '.rdo') throw new Error('请选择 Remote Desktop Organizer 的 .rdo 文件')
  const descriptor = openSync(filePath, 'r')
  let bytes: Buffer | undefined
  try {
    const information = fstatSync(descriptor)
    if (!information.isFile() || information.size < 17 || information.size > 8 * 1024 * 1024) throw new Error('RDO 文件无效或超过 8 MB 上限')
    bytes = Buffer.alloc(information.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null)
      if (!read) throw new Error('读取 RDO 文件失败，请确认文件未被其他程序修改')
      offset += read
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null)) throw new Error('RDO 文件在读取时发生变化，请重新选择')
    const parsed = parseRdo(bytes, existing)
    return { source: 'rdo', scanId: createImportScan(parsed.credentials), dbPath: filePath, dataDir: dirname(filePath), modifiedAt: information.mtimeMs,
      candidates: parsed.candidates, summary: { sshTotal: 0, rdpTotal: parsed.candidates.length, groups: parsed.groups,
        encryptedCredentials: parsed.candidates.filter(candidate => !candidate.credentialAvailable).length,
        duplicates: parsed.candidates.filter(candidate => candidate.duplicate).length }, warnings: parsed.warnings }
  } finally {
    bytes?.fill(0)
    closeSync(descriptor)
  }
}
