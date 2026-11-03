import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppRelease, AppUpdateStatus } from '@shared/updates.js'
import { APP_UPDATE_REPOSITORY } from '@shared/updates.js'
import { writeConfigurationFile } from './config-backup.js'

const repository = APP_UPDATE_REPOSITORY
const releasePage = 'https://github.com/' + repository + '/releases'
const latestApi = 'https://api.github.com/repos/' + repository + '/releases/latest'
const day = 24 * 60 * 60 * 1000

function versionParts(input: string): { numbers: number[]; prerelease: string[] } {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(input)
  if (!match || input.length > 128 || match.slice(1, 4).some(value => !Number.isSafeInteger(Number(value))) || match[4]?.split('.').some(value => /^\d+$/.test(value) && value.length > 1 && value[0] === '0')) throw new Error('版本号格式无效')
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] }
}

export function compareVersions(first: string, second: string): number {
  const left = versionParts(first)
  const right = versionParts(second)
  for (let index = 0; index < 3; index++) if (left.numbers[index] !== right.numbers[index]) return Math.sign(left.numbers[index] - right.numbers[index])
  if (!left.prerelease.length || !right.prerelease.length) return Number(!left.prerelease.length) - Number(!right.prerelease.length)
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

function releaseFrom(input: unknown): AppRelease {
  if (!input || typeof input !== 'object') throw new Error('GitHub 发布信息格式无效')
  const release = input as Record<string, unknown>
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || versionParts(release.tag_name).prerelease.length) throw new Error('更新源未返回有效的正式版本')
  if (typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) throw new Error('发布信息缺少有效发布时间')
  return {
    tag: release.tag_name,
    version: release.tag_name.replace(/^v/, ''), name: typeof release.name === 'string' ? release.name.slice(0, 200) : release.tag_name,
    notes: typeof release.body === 'string' ? release.body.slice(0, 12000) : '', publishedAt: release.published_at,
    url: releasePage + '/tag/' + encodeURIComponent(release.tag_name)
  }
}

export class AppUpdateService extends EventEmitter {
  private path: string
  private state: AppUpdateStatus
  private lastAttemptAt = 0
  private pending?: Promise<AppUpdateStatus>
  private controller?: AbortController
  private timer?: NodeJS.Timeout
  private interval?: NodeJS.Timeout
  private disposed = false

  constructor(directory: string, currentVersion: string, private readonly fetcher: typeof fetch = fetch) {
    super()
    versionParts(currentVersion)
    this.path = join(directory, 'app-updates.json')
    this.state = { currentVersion, autoCheck: true, checking: false, available: false }
    try {
      if (existsSync(this.path)) {
        const saved = JSON.parse(readFileSync(this.path, 'utf8'))
        if (typeof saved.autoCheck === 'boolean') this.state.autoCheck = saved.autoCheck
        if (Number.isFinite(saved.lastAttemptAt) && saved.lastAttemptAt <= Date.now()) this.lastAttemptAt = saved.lastAttemptAt
        if (Number.isFinite(saved.lastCheckedAt) && saved.lastCheckedAt <= Date.now()) this.state.lastCheckedAt = saved.lastCheckedAt
        if (saved.release) {
          const release = releaseFrom(saved.release)
          this.state.release = release
          this.state.available = compareVersions(release.version, currentVersion) > 0
        }
      }
    } catch {}
  }

  status(): AppUpdateStatus { return structuredClone(this.state) }

  private persist(): void {
    const release = this.state.release
    writeConfigurationFile(this.path, JSON.stringify({ autoCheck: this.state.autoCheck, lastAttemptAt: this.lastAttemptAt, lastCheckedAt: this.state.lastCheckedAt, release: release && { tag_name: release.tag, name: release.name, body: release.notes, published_at: release.publishedAt, draft: false, prerelease: false } }))
  }

  private changed(): AppUpdateStatus { const status = this.status(); this.emit('changed', status); return status }

  setAutoCheck(enabled: boolean): AppUpdateStatus {
    if (typeof enabled !== 'boolean') throw new Error('自动检查设置格式不正确')
    const previous = this.state.autoCheck
    this.state.autoCheck = enabled
    try { this.persist() } catch (error) { this.state.autoCheck = previous; throw error }
    return this.changed()
  }

  releaseUrl(): string {
    if (!this.state.available || !this.state.release) throw new Error('尚未发现可下载的新版本，请先检查更新')
    return this.state.release.url
  }

  start(): void {
    if (this.timer || this.interval || this.disposed) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.check(false) }, 30000)
    this.interval = setInterval(() => { void this.check(false) }, 6 * 60 * 60 * 1000)
    this.timer.unref(); this.interval.unref()
  }

  check(manual = true): Promise<AppUpdateStatus> {
    if (this.pending) return this.pending
    if (this.disposed || (!manual && (!this.state.autoCheck || Date.now() - this.lastAttemptAt < (this.state.error ? 60 * 60 * 1000 : day)))) return Promise.resolve(this.status())
    this.pending = this.performCheck().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async performCheck(): Promise<AppUpdateStatus> {
    this.state.checking = true; this.state.error = undefined; this.lastAttemptAt = Date.now(); this.changed()
    const controller = this.controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)
    try {
      const response = await this.fetcher(latestApi, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OmniDesk/' + this.state.currentVersion } })
      try {
        if (response.status === 404) throw new Error('GitHub 更新源不可公开访问：仓库可能为私有，或尚未发布正式 Release。公开 Releases 后即可免登录检查；客户端不保存 GitHub Token。')
        if ([403, 429].includes(response.status)) throw new Error('GitHub 请求受到限制，请稍后重试；不会影响本地连接。')
        if (!response.ok) throw new Error('GitHub 更新服务暂不可用（HTTP ' + response.status + '），请稍后重试。')
        const chunks: Uint8Array[] = []
        let length = 0
        for await (const chunk of response.body!) {
          length += chunk.byteLength
          if (length > 1024 * 1024) throw new Error('GitHub 发布信息过大，已停止检查')
          chunks.push(chunk)
        }
        const release = releaseFrom(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        this.state.release = release
        this.state.available = compareVersions(release.version, this.state.currentVersion) > 0
        this.state.lastCheckedAt = Date.now()
      } finally { await response.body?.cancel().catch(() => {}) }
    } catch (error) {
      if (!this.disposed) this.state.error = controller.signal.aborted ? '检查更新超时，请检查网络后重试；SSH / RDP 等功能不受影响。' : error instanceof Error && /^(GitHub|更新源)/.test(error.message) ? error.message : '无法读取 GitHub 更新信息，请检查网络或系统代理后重试；不会影响本地功能。'
    } finally {
      clearTimeout(timeout); this.controller = undefined; this.state.checking = false
      if (!this.disposed) {
        try { this.persist() } catch { this.state.error = '无法保存更新检查状态，请检查本机数据目录权限；本地连接不受影响。' }
        this.changed()
      }
    }
    return this.status()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer); clearInterval(this.interval); this.controller?.abort()
    this.removeAllListeners()
  }
}
