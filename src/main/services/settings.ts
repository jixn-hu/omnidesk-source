/**
 * 设置存储（含对外访问配置）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { DEFAULT_PORTS } from '@shared/constants.js'
import type { AccessToken, ExternalAccessConfig, ExternalScope } from '@shared/types.js'

interface SettingsShape {
  version: 1
  theme: 'system' | 'light' | 'dark'
  language: 'zh-CN' | 'en-US'
  terminal: {
    fontSize: number
    fontFamily: string
    scrollback: number
    cursorStyle: 'block' | 'underline' | 'bar'
  }
  external: ExternalAccessConfig
}

const DEFAULTS: SettingsShape = {
  version: 1,
  theme: 'system',
  language: 'zh-CN',
  terminal: {
    fontSize: 14,
    fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
    scrollback: 5000,
    cursorStyle: 'bar'
  },
  external: {
    mcp: { enabled: false, host: '127.0.0.1', port: DEFAULT_PORTS.mcp, tokens: [] },
    api: { enabled: false, host: '127.0.0.1', port: DEFAULT_PORTS.api, tokens: [] }
  }
}

export class SettingsService {
  private path: string
  private data: SettingsShape

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.data = this.load()
  }

  private load(): SettingsShape {
    if (!existsSync(this.path)) return structuredClone(DEFAULTS)
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SettingsShape>
      return {
        ...structuredClone(DEFAULTS),
        ...raw,
        terminal: { ...DEFAULTS.terminal, ...(raw.terminal ?? {}) },
        external: {
          mcp: { ...DEFAULTS.external.mcp, ...(raw.external?.mcp ?? {}) },
          api: { ...DEFAULTS.external.api, ...(raw.external?.api ?? {}) }
        }
      }
    } catch {
      return structuredClone(DEFAULTS)
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8')
  }

  all(): SettingsShape {
    return this.data
  }

  update(patch: Partial<SettingsShape>): SettingsShape {
    this.data = {
      ...this.data,
      ...patch,
      terminal: { ...this.data.terminal, ...(patch.terminal ?? {}) }
    }
    this.persist()
    return this.data
  }

  /* ---------------- 对外访问 ---------------- */

  getExternalConfig(): ExternalAccessConfig {
    return this.data.external
  }

  setEnabled(which: 'mcp' | 'api', enabled: boolean): ExternalAccessConfig {
    this.data.external[which].enabled = enabled
    this.persist()
    return this.data.external
  }

  setPort(which: 'mcp' | 'api', port: number): ExternalAccessConfig {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('端口必须是 1024 - 65535 之间的整数')
    }
    this.data.external[which].port = port
    this.persist()
    return this.data.external
  }

  /**
   * 创建访问令牌。
   * 明文只在这一次返回 —— 存储里只有哈希，之后无法再取出。
   */
  createToken(
    which: 'mcp' | 'api',
    label: string,
    scopes: ExternalScope[],
    allowWriteWithoutApproval = false
  ): { token: AccessToken; plaintext: string } {
    if (!label.trim()) throw new Error('令牌标签不能为空')
    if (scopes.length === 0) throw new Error('至少选择一个权限范围')

    const plaintext = 'odk_' + randomBytes(24).toString('base64url')
    const token: AccessToken = {
      id: randomUUID(),
      label: label.trim(),
      tokenHash: hashToken(plaintext),
      scopes,
      createdAt: Date.now(),
      allowWriteWithoutApproval
    }
    this.data.external[which].tokens.push(token)
    this.persist()
    return { token, plaintext }
  }

  revokeToken(which: 'mcp' | 'api', tokenId: string): ExternalAccessConfig {
    this.data.external[which].tokens = this.data.external[which].tokens.filter((t) => t.id !== tokenId)
    this.persist()
    return this.data.external
  }

  /** 校验令牌，返回匹配的 token 记录（并记录使用时间） */
  verifyToken(which: 'mcp' | 'api', plaintext: string): AccessToken | null {
    const hash = hashToken(plaintext)
    const found = this.data.external[which].tokens.find((t) => t.tokenHash === hash)
    if (!found) return null
    // 节流写入，避免每次请求都落盘
    const now = Date.now()
    if (!found.lastUsedAt || now - found.lastUsedAt > 60_000) {
      found.lastUsedAt = now
      this.persist()
    }
    return found
  }
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}
