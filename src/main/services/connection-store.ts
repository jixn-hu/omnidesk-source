/**
 * 连接配置存储
 *
 * 连接配置本身不含任何密钥材料 —— 密钥在 Vault 里，这里只存 credentialRef。
 * 所以这个文件可以是明文的（也方便用户直接看/备份）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONNECTIONS_FILE } from '@shared/constants.js'
import type { Connection, RdpConnection } from '@shared/types.js'
import { connectionKey, parseConnectionAddress } from '@shared/connection-identity.js'

import { applyMetadataChanges, type BatchMetadataRequest } from '@shared/server-metadata.js'

interface StoreShape {
  version: 1
  connections: Connection[]
}

export class ConnectionStore {
  private path: string
  private data: StoreShape = { version: 1, connections: [] }

  constructor(userDataDir: string) {
    this.path = join(userDataDir, CONNECTIONS_FILE)
    mkdirSync(dirname(this.path), { recursive: true })
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StoreShape
      if (raw && Array.isArray(raw.connections)) this.data = raw
    } catch {
      // 文件损坏时不阻塞启动，备份一份再说
      try {
        writeFileSync(this.path + '.corrupt', readFileSync(this.path))
      } catch {
        /* ignore */
      }
      this.data = { version: 1, connections: [] }
    }
  }

  private persist(next: StoreShape): void {
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8')
    renameSync(temporary, this.path)
    this.data = next
  }

  list(): Connection[] {
    return structuredClone(this.data.connections)
  }

  reload(): void {
    this.load()
  }

  get(id: string): Connection | null {
    return structuredClone(this.data.connections.find((c) => c.id === id) ?? null)
  }

  /** 新增或更新 */
  duplicates(input: Pick<Connection, 'kind' | 'host' | 'port'> & { id?: string }): Connection[] {
    return this.list().filter((connection) => connection.id !== input.id && connectionKey(connection) === connectionKey(input))
  }

  save(input: Partial<Connection> & { name: string; host: string; port: number; kind: Connection['kind'] }, allowDuplicate = false): Connection {
    if (!input.name?.trim() || !input.host?.trim()) throw new Error('连接名称和主机地址不能为空')
    parseConnectionAddress(input.host, input.port)
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('服务端口必须为 1–65535 之间的整数')
    if (input.kind !== 'ssh' && input.kind !== 'rdp') throw new Error('不支持的连接类型')
    const previous = input.id ? this.get(input.id) : null
    if (input.id && !previous) throw new Error('连接不存在，请刷新后重试')
    if (!allowDuplicate && (!previous || connectionKey(previous) !== connectionKey(input)) && this.duplicates(input).length) throw new Error('已存在相同协议、服务器地址和端口的连接，请确认是否仍要新增')
    input = { ...input, name: input.name.trim(), host: input.host.trim() }
    if (input.kind === 'rdp') input = { ...input, options: { ignoreCertificate: true, ...(previous?.kind === 'rdp' ? previous.options : undefined), ...(input as Partial<RdpConnection>).options } } as typeof input
    const now = Date.now()
    if (input.id) {
      const idx = this.data.connections.findIndex((c) => c.id === input.id)
      if (idx >= 0) {
        if (this.data.connections[idx].kind !== input.kind) throw new Error('已有连接不能更改协议类型，请新建连接')
        const merged = { ...this.data.connections[idx], ...input, updatedAt: Math.max(now, this.data.connections[idx].updatedAt + 1) } as Connection
        const next = this.list()
        next[idx] = merged
        this.persist({ version: 1, connections: next })
        return structuredClone(merged)
      }
      throw new Error('连接不存在，请刷新后重试')
    }
    const created = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      exposedToExternal: input.exposedToExternal ?? false
    } as Connection
    this.persist({ version: 1, connections: [...this.data.connections, created] })
    return structuredClone(created)
  }

  batchMetadata(request: BatchMetadataRequest): Connection[] {
    const entries = request?.items
    if (!Array.isArray(entries) || !entries.length || entries.length > 1000 || entries.some(item => !item || typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.updatedAt)) || new Set(entries.map(item => item.id)).size !== entries.length) throw new Error('请选择 1–1000 台服务器，且不能重复')
    const updates = new Map(entries.map(item => {
      const current = this.get(item.id)
      if (!current || current.updatedAt !== item.updatedAt) throw new Error('服务器已被修改或删除，请刷新后重试；本次未修改任何服务器')
      return [item.id, { ...current, ...applyMetadataChanges(current, request.changes), updatedAt: Math.max(Date.now(), current.updatedAt + 1) } as Connection]
    }))
    this.persist({ version: 1, connections: this.list().map(item => updates.get(item.id) ?? item) })
    return this.list()
  }

  delete(id: string): boolean {
    const before = this.data.connections.length
    const next = this.data.connections.filter((c) => c.id !== id)
    if (next.length !== before) {
      this.persist({ version: 1, connections: next })
      return true
    }
    return false
  }

  /** 列出所有分组名 */
  groups(): string[] {
    const set = new Set<string>()
    for (const c of this.data.connections) {
      if (c.group) set.add(c.group)
    }
    return [...set].sort()
  }

  /** 允许外部访问的连接 */
  exposed(): Connection[] {
    return this.data.connections.filter((c) => c.exposedToExternal)
  }

  /** 切换某连接的对外暴露开关 */
  setExposed(id: string, exposed: boolean): void {
    const c = this.data.connections.find((x) => x.id === id)
    if (!c) throw new Error('连接不存在')
    this.save({ ...c, exposedToExternal: exposed })
  }
}
