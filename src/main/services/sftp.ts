/**
 * SFTP 文件服务
 *
 * 职责：远端目录浏览、文件读写、上传下载（带进度）。
 * 所有路径都做规范化，拒绝跳出允许范围的相对路径。
 */
import { createReadStream, createWriteStream, statSync, mkdirSync } from 'node:fs'
import { basename, dirname, posix, resolve, sep, join } from 'node:path'
import { lstat, readdir, mkdtemp, mkdir, statfs, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { offerVirtualFiles } from './virtual-files.js'
import { encodeFileDescriptors } from './freerdp-files.js'
import { randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { pipeline } from 'node:stream/promises'
import type { FileEntry } from 'ssh2'
import type { RemoteFileEntry, TransferTask } from '@shared/types.js'
import type { SshService } from './ssh.js'

interface SftpHandle {
  sessionId: string
  sftp: import('ssh2').SFTPWrapper
}

export class SftpService extends EventEmitter {
  private handles = new Map<string, SftpHandle>()
  private transfers = new Map<string, TransferTask>()
  private cancelled = new Set<string>()
  private activeTransfers = new Map<string, AbortController>()

  constructor(private ssh: SshService) {
    super()
  }

  /* ---------------------------------------------------------------- */
  /* 通道管理                                                          */
  /* ---------------------------------------------------------------- */

  /** 复用同一会话上的 SFTP 通道 */
  private async getSftp(sessionId: string): Promise<import('ssh2').SFTPWrapper> {
    const existing = this.handles.get(sessionId)
    if (existing) return existing.sftp

    const client = this.ssh.getClient(sessionId)
    const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
      client.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)))
    })

    this.handles.set(sessionId, { sessionId, sftp })
    sftp.on('close', () => this.handles.delete(sessionId))
    return sftp
  }

  private requireHandle(sessionId: string): import('ssh2').SFTPWrapper {
    const h = this.handles.get(sessionId)
    if (!h) throw new Error('SFTP 通道未建立')
    return h.sftp
  }

  /* ---------------------------------------------------------------- */
  /* 目录浏览                                                          */
  /* ---------------------------------------------------------------- */

  async list(sessionId: string, remotePath: string): Promise<{ path: string; entries: RemoteFileEntry[] }> {
    const sftp = await this.getSftp(sessionId)
    const dir = normalizeRemotePath(remotePath)

    const entries = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
    })

    const mapped: RemoteFileEntry[] = entries.map((e) => {
      const fileType = e.attrs.mode & 0o170000
      const isDir = fileType === 0o040000
      const isLink = fileType === 0o120000
      return {
        name: e.filename,
        path: posix.join(dir, e.filename),
        type: isDir ? 'directory' : isLink ? 'symlink' : fileType === 0o100000 ? 'file' : 'other',
        size: e.attrs.size,
        mode: e.attrs.mode,
        modeText: formatMode(e.attrs.mode),
        mtime: e.attrs.mtime * 1000,
        uid: e.attrs.uid,
        gid: e.attrs.gid
      }
    })

    // 目录在前，各自按名称排序（不区分大小写）
    mapped.sort((a, b) => {
      const aDir = a.type === 'directory' ? 0 : 1
      const bDir = b.type === 'directory' ? 0 : 1
      if (aDir !== bDir) return aDir - bDir
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })

    return { path: dir, entries: mapped }
  }

  /** 读取文本文件（带大小上限，避免把大文件读进内存） */
  async readFile(sessionId: string, remotePath: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
    const sftp = await this.getSftp(sessionId)
    const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
      sftp.stat(remotePath, (err, s) => (err ? reject(err) : resolve(s)))
    })
    if (stat.size > maxBytes) {
      throw new Error(`文件过大（${formatBytes(stat.size)}），超过 ${formatBytes(maxBytes)} 上限`)
    }
    if (!stat.isFile()) throw new Error('只能编辑普通文本文件')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of sftp.createReadStream(remotePath, { start: 0, end: maxBytes })) {
      const data = Buffer.from(chunk)
      size += data.length
      if (size > maxBytes) throw new Error(`文件过大，超过 ${formatBytes(maxBytes)} 上限`)
      chunks.push(data)
    }
    const buf = Buffer.concat(chunks)
    if (buf.includes(0) || !isUtf8(buf)) throw new Error('该文件不是 UTF-8 文本，不能直接编辑；请下载后使用合适的程序打开')
    return buf.toString('utf8')
  }

  async writeFile(sessionId: string, remotePath: string, content: string, expectedContent?: string): Promise<void> {
    if (expectedContent !== undefined && await this.readFile(sessionId, remotePath) !== expectedContent) {
      throw new Error('远程文件已被其他程序修改，未覆盖。请保留当前内容，重新打开文件后再合并修改')
    }
    const sftp = await this.getSftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, Buffer.from(content, 'utf8'), (err) => (err ? reject(err) : resolve()))
    })
  }

  async createFile(sessionId: string, remotePath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(remotePath, 'wx', (error, value) => error ? reject(error) : resolve(value))
    })
    await new Promise<void>((resolve, reject) => {
      sftp.close(handle, error => error ? reject(error) : resolve())
    })
  }

  async mkdir(sessionId: string, remotePath: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()))
    })
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  /** 删除文件或空目录 */
  async remove(sessionId: string, remotePath: string, isDir: boolean): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      const cb = (err: Error | null | undefined) => (err ? reject(err) : resolve())
      if (isDir) sftp.rmdir(remotePath, cb)
      else sftp.unlink(remotePath, cb)
    })
  }

  /* ---------------------------------------------------------------- */
  /* 传输                                                              */
  /* ---------------------------------------------------------------- */

  listTransfers(sessionId?: string): TransferTask[] {
    const all = [...this.transfers.values()]
    return sessionId ? all.filter((t) => t.sessionId === sessionId) : all
  }

  cancelTransfer(taskId: string): void {
    const task = this.transfers.get(taskId)
    if (task && task.status === 'running') {
      this.cancelled.add(taskId)
      this.activeTransfers.get(taskId)?.abort()
      task.status = 'cancelled'
      this.emit('progress', task)
    }
  }

  /** 下载：远端 → 本地 */
  async download(sessionId: string, remotePath: string, localPath: string): Promise<TransferTask> {
    const sftp = await this.getSftp(sessionId)
    const task: TransferTask = {
      id: randomUUID(),
      sessionId,
      direction: 'download',
      localPath,
      remotePath,
      size: 0,
      transferred: 0,
      status: 'running'
    }
    this.transfers.set(task.id, task)

    try {
      const stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
        sftp.stat(remotePath, (err, s) => (err ? reject(err) : resolve(s)))
      })
      task.size = stat.size

      // 确保本地目录存在
      try {
        mkdirSync(dirname(localPath), { recursive: true })
      } catch {
        /* ignore */
      }

      const readStream = sftp.createReadStream(remotePath)
      const writeStream = createWriteStream(localPath)

      const controller = new AbortController()
      this.activeTransfers.set(task.id, controller)
      readStream.on('data', (chunk: string | Buffer) => {
        task.transferred += Buffer.byteLength(chunk)
        this.emit('progress', task)
      })
      if (this.cancelled.has(task.id)) controller.abort()
      await pipeline(readStream, writeStream, { signal: controller.signal })

      task.status = this.cancelled.has(task.id) ? 'cancelled' : 'done'
      this.emit('progress', task)
      return task
    } catch (err) {
      if (this.cancelled.has(task.id)) {
        task.status = 'cancelled'
        this.emit('progress', task)
        return task
      }
      task.status = 'error'
      task.error = err instanceof Error ? err.message : String(err)
      this.emit('progress', task)
      throw err
    } finally {
      this.cancelled.delete(task.id)
      this.activeTransfers.delete(task.id)
    }
  }

  async move(sessionId: string, source: string, destination: string): Promise<void> {
    if (typeof source !== 'string' || typeof destination !== 'string' || !source.startsWith('/') || !destination.startsWith('/') || /[\0\r\n]/.test(source + destination)) throw new Error('拖拽移动需要有效的绝对路径')
    const from = normalizeRemotePath(source), directory = normalizeRemotePath(destination), to = posix.join(directory, posix.basename(from))
    if (from === '/' || to === from) return
    if (directory.startsWith(from + '/')) throw new Error('不能将文件夹移入自身或子目录')
    const sftp = await this.getSftp(sessionId)
    const targetDirectory = await new Promise<import('ssh2').Stats>((resolve, reject) => sftp.lstat(directory, (error, info) => error ? reject(error) : resolve(info)))
    if (!targetDirectory.isDirectory() || targetDirectory.isSymbolicLink()) throw new Error('只能移动到普通文件夹')
    await new Promise<void>((resolve, reject) => sftp.lstat(to, (error, info) => info ? reject(new Error('目标已存在同名文件，未覆盖')) : error && (error as Error & { code?: number }).code !== 2 ? reject(error) : resolve()))
    await this.rename(sessionId, from, to)
  }

  async uploadDropped(sessionId: string, localPaths: string[], remoteDirectory: string): Promise<TransferTask[]> {
    if (!Array.isArray(localPaths) || !localPaths.length || localPaths.length > 1000 || localPaths.some(path => typeof path !== 'string' || !path || path.includes('\0'))) throw new Error('请拖入本机文件或文件夹')
    const destination = normalizeRemotePath(remoteDirectory)
    if (!destination.startsWith('/')) throw new Error('上传目录必须是绝对路径')
    const entries: { local: string; remote: string; directory: boolean; exists?: boolean }[] = []
    const names = new Set<string>()
    const visit = async (local: string, remote: string): Promise<void> => {
      if (entries.length >= 4096) throw new Error('单次拖入最多 4096 个文件与目录')
      const info = await lstat(local)
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error('暂不支持拖入链接或特殊文件')
      if (names.has(remote)) throw new Error('拖入的文件存在同名目标，请分别上传')
      names.add(remote); entries.push({ local, remote, directory: info.isDirectory() })
      if (info.isDirectory()) for (const child of await readdir(local)) await visit(join(local, child), posix.join(remote, child))
    }
    for (const local of [...new Set(localPaths)]) await visit(local, posix.join(destination, basename(local)))
    const sftp = await this.getSftp(sessionId)
    for (const entry of entries) await new Promise<void>((resolve, reject) => sftp.lstat(entry.remote, (error, info) => {
      if (info) { if (entry.directory && info.isDirectory() && !info.isSymbolicLink()) { entry.exists = true; resolve() } else reject(new Error('目标已存在同名文件，未覆盖：' + posix.basename(entry.remote))) }
      else if (error && (error as Error & { code?: number }).code !== 2) reject(error)
      else resolve()
    }))
    const tasks: TransferTask[] = []
    for (const entry of entries) {
      if (entry.directory) { if (!entry.exists) await this.mkdir(sessionId, entry.remote) }
      else tasks.push(await this.upload(sessionId, entry.local, entry.remote, false))
    }
    return tasks
  }

  async dragToLocal(sessionId: string, remotePath: string, helperDirectory: string): Promise<void> {
    if (process.platform !== 'win32') throw new Error('拖到本机目前支持 Windows，请使用下载按钮')
    if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || /[\0\r\n]/.test(remotePath)) throw new Error('远程路径无效')
    const entries: { name: string; path: string; directory: boolean; size: number }[] = []
    const sftp = await this.getSftp(sessionId)
    const visit = async (path: string, name: string): Promise<void> => {
      if (entries.length >= 4096) throw new Error('单次拖出最多 4096 个文件与目录')
      const info = await new Promise<import('ssh2').Stats>((resolve, reject) => sftp.lstat(path, (error, value) => error ? reject(error) : resolve(value)))
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('暂不支持拖出链接或特殊文件')
      entries.push({ name, path, directory: info.isDirectory(), size: info.isDirectory() ? 0 : info.size })
      if (info.isDirectory()) for (const entry of (await this.list(sessionId, path)).entries) await visit(entry.path, name + '\\' + entry.name)
    }
    await visit(remotePath, posix.basename(remotePath))
    const descriptors = encodeFileDescriptors(entries)
    const root = join(tmpdir(), 'omnidesk-sftp-drag')
    await mkdir(root, { recursive: true })
    const free = await statfs(root), total = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (Number(free.bavail) * Number(free.bsize) < total + 512 * 1024 ** 2) throw new Error('本机临时目录空间不足')
    const cache = await mkdtemp(join(root, 'drag-'))
    const downloads = new Map<number, Promise<string>>()
    try {
      const offer = await offerVirtualFiles(helperDirectory, descriptors, 0, index => {
        const entry = entries[index]
        if (!entry || entry.directory) return Promise.reject(new Error('文件索引无效'))
        let downloading = downloads.get(index)
        if (!downloading) {
          const target = join(cache, String(index))
          downloading = this.download(sessionId, entry.path, target).then(task => { if (task.status !== 'done') throw new Error('下载已取消'); return target })
          downloads.set(index, downloading)
        }
        return downloading
      }, 'drag')
      await offer.finished
    } finally {
      // A stream returned to Explorer can outlive the drag callback; retain its cache for 24 hours.
      for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && /^drag-[\w-]{6}$/.test(entry.name)) {
        const candidate = join(root, entry.name), info = await lstat(candidate)
        if (!info.isSymbolicLink() && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) await rm(candidate, { recursive: true, force: true })
      }
    }
  }

  /** 上传：本地 → 远端 */
  async upload(sessionId: string, localPath: string, remotePath: string, overwrite = true): Promise<TransferTask> {
    const sftp = await this.getSftp(sessionId)
    const task: TransferTask = {
      id: randomUUID(),
      sessionId,
      direction: 'upload',
      localPath,
      remotePath,
      size: 0,
      transferred: 0,
      status: 'running'
    }
    this.transfers.set(task.id, task)

    try {
      task.size = statSync(localPath).size

      const readStream = createReadStream(localPath)
      const writeStream = sftp.createWriteStream(remotePath, { flags: overwrite ? 'w' : 'wx' })

      const controller = new AbortController()
      this.activeTransfers.set(task.id, controller)
      readStream.on('data', (chunk: string | Buffer) => {
        task.transferred += Buffer.byteLength(chunk)
        this.emit('progress', task)
      })
      await pipeline(readStream, writeStream, { signal: controller.signal })

      task.status = this.cancelled.has(task.id) ? 'cancelled' : 'done'
      this.emit('progress', task)
      return task
    } catch (err) {
      if (this.cancelled.has(task.id)) {
        task.status = 'cancelled'
        this.emit('progress', task)
        return task
      }
      task.status = 'error'
      task.error = err instanceof Error ? err.message : String(err)
      this.emit('progress', task)
      throw err
    } finally {
      this.cancelled.delete(task.id)
      this.activeTransfers.delete(task.id)
    }
  }

  dispose(): void {
    for (const taskId of this.activeTransfers.keys()) this.cancelTransfer(taskId)
    for (const h of this.handles.values()) {
      try {
        h.sftp.end()
      } catch {
        /* ignore */
      }
    }
    this.handles.clear()
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 规范化远端路径：一律用 POSIX 分隔符，清理 . 和 .. */
export function normalizeRemotePath(p: string): string {
  const cleaned = (p || '.').replace(/\\/g, '/')
  const normalized = posix.normalize(cleaned)
  return normalized.startsWith('/') ? normalized : posix.join('/', normalized)
}

/** 防止本地路径穿越 */
export function assertInsideHome(target: string, allowedRoot: string): void {
  const t = resolve(target)
  const r = resolve(allowedRoot)
  if (t !== r && !t.startsWith(r + sep)) {
    throw new Error('路径超出允许范围')
  }
}

/** 权限位转 rwx 字符串 */
function formatMode(mode: number): string {
  const chars = ['r', 'w', 'x']
  let out = ''
  for (let i = 8; i >= 0; i--) {
    out += mode & (1 << i) ? chars[(8 - i) % 3] : '-'
  }
  return out
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export { formatBytes }
