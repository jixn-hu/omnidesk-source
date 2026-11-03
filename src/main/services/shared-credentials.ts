/**
 * 公共凭据（共享密码）
 *
 * 【解决的场景】
 * 手上有几十台机器用同一个密码（或同一把私钥）。逐台填写既费事，
 * 改密码时更是一场灾难 —— 得挨个改一遍，还容易漏。
 *
 * 做法：把凭据抽出来命名一次，多条连接引用它。改一次，全部生效。
 *
 * 【与普通凭据的关系】
 * 两者都存在同一个保险箱里（都是 credentialRef），区别只是「有没有名字、
 * 能不能被多条连接共用」。所以加密强度完全一致，不存在安全降级。
 *
 * 存储：shared-credentials.json —— 只存名字和引用，真正的密钥在 vault.enc 里。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SharedCredential } from '@shared/types.js'

const FILE = 'shared-credentials.json'

interface StoreShape {
  version: 1
  credentials: SharedCredential[]
}

export class SharedCredentialStore {
  private path: string
  private data: StoreShape = { version: 1, credentials: [] }

  constructor(userDataDir: string) {
    this.path = join(userDataDir, FILE)
    mkdirSync(userDataDir, { recursive: true })
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StoreShape
      if (raw && Array.isArray(raw.credentials)) this.data = raw
    } catch {
      this.data = { version: 1, credentials: [] }
    }
  }

  private persist(next: StoreShape): void {
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8')
    renameSync(temporary, this.path)
    this.data = next
  }

  list(): SharedCredential[] {
    return structuredClone(this.data.credentials)
  }

  reload(): void {
    this.load()
  }

  get(id: string): SharedCredential | null {
    return structuredClone(this.data.credentials.find((c) => c.id === id) ?? null)
  }

  /** 新增或更新。id 为空表示新建 */
  save(input: {
    id?: string
    name: string
    kind: SharedCredential['kind']
    username?: string
    domain?: string
    credentialRef: string
    note?: string
  }): SharedCredential {
    const now = Date.now()

    if (input.id) {
      const idx = this.data.credentials.findIndex((c) => c.id === input.id)
      if (idx >= 0) {
        const merged: SharedCredential = {
          ...this.data.credentials[idx]!,
          name: input.name.trim(),
          kind: input.kind,
          username: input.username?.trim() || undefined,
          domain: input.domain?.trim() || undefined,
          credentialRef: input.credentialRef,
          note: input.note,
          updatedAt: now
        }
        const next = this.list()
        next[idx] = merged
        this.persist({ version: 1, credentials: next })
        return structuredClone(merged)
      }
      throw new Error('公共凭据不存在，请刷新后重试')
    }

    const created: SharedCredential = {
      id: randomUUID(),
      name: input.name.trim(),
      kind: input.kind,
      username: input.username?.trim() || undefined,
      domain: input.domain?.trim() || undefined,
      credentialRef: input.credentialRef,
      note: input.note,
      createdAt: now,
      updatedAt: now
    }
    this.persist({ version: 1, credentials: [...this.data.credentials, created] })
    return structuredClone(created)
  }

  delete(id: string): boolean {
    const before = this.data.credentials.length
    const next = this.data.credentials.filter((c) => c.id !== id)
    if (next.length !== before) {
      this.persist({ version: 1, credentials: next })
      return true
    }
    return false
  }

  /** 某条公共凭据被多少连接引用 —— 删除前用来提示影响范围 */
  countUsage(id: string, connections: Array<{ sharedCredentialId?: string }>): number {
    return connections.filter((c) => c.sharedCredentialId === id).length
  }
}
