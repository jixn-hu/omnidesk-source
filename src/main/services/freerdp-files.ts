import { spawn } from 'node:child_process'
import { offerVirtualFiles, type VirtualFileOffer } from './virtual-files.js'
import { constants } from 'node:fs'
import { lstat, readdir, open, mkdir, mkdtemp, rm, statfs, type FileHandle } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, basename, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeCommand, nativeNumbers, type RdpFileTransferStatus } from '@shared/freerdp-protocol.js'

const MAX_FILES = 4096
const MAX_BYTES = 16 * 1024 ** 3
const CHUNK = 256 * 1024
const DESCRIPTOR_SIZE = 592
const FORMAT_DIRECTORY = 0x10
const TIMEOUT = 30_000
const activeCopies = new Set<string>()

async function removeCachedCopy(root: string, directory: string): Promise<void> {
  const target = resolve(directory)
  if (dirname(target) !== resolve(root) || !/^copy-[\w-]{6}$/.test(basename(target))) throw new Error('临时文件清理路径越界')
  await rm(target, { recursive: true, force: true })
}

async function pruneCache(root: string, protectedPaths: string[]): Promise<void> {
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文件剪贴板临时目录不能是链接')
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!/^copy-[\w-]{6}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const directory = join(root, entry.name)
    if (activeCopies.has(directory)) continue
    if (protectedPaths.some(path => { const child = relative(directory, path); return !child || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) })) continue
    const stat = await lstat(directory)
    if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await removeCachedCopy(root, directory).catch(() => {})
  }
}

interface ClipboardSnapshot { sequence: number; paths: string[] }
export interface FileClipboard {
  read(): Promise<ClipboardSnapshot>
  write(paths: string[], sequence: number): Promise<number>
  offer?(descriptors: Buffer, sequence: number, readFile: (index: number) => Promise<string>): Promise<VirtualFileOffer>
}
interface Entry { name: string; directory: boolean; size: number; handle?: FileHandle; ranges?: Array<[number, number]>; transferred?: number; complete?: boolean }
interface Pending { resolve(data: Buffer): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export function parseFileDescriptors(data: Buffer): Entry[] {
  if (data.length < 4) throw new Error('远端文件列表不完整')
  const count = data.readUInt32LE(0)
  if (!count || count > MAX_FILES || data.length !== 4 + count * DESCRIPTOR_SIZE) throw new Error('远端文件列表格式错误或超过 4096 项')
  const entries: Entry[] = []
  const names = new Map<string, boolean>()
  let total = 0
  for (let index = 0; index < count; index++) {
    const descriptor = data.subarray(4 + index * DESCRIPTOR_SIZE, 4 + (index + 1) * DESCRIPTOR_SIZE)
    let end = 72
    while (end < DESCRIPTOR_SIZE && descriptor.readUInt16LE(end)) end += 2
    if (end === DESCRIPTOR_SIZE) throw new Error('远端文件名没有结束标记')
    const name = descriptor.toString('utf16le', 72, end)
    const parts = name.split('\\')
    if (!name || name.includes('/') || parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f<>:"|?*\uD800-\uDFFF]/u.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .]|$)/i.test(part))) throw new Error('远端文件名不安全，已拒绝下载')
    const flags = descriptor.readUInt32LE(0)
    if (!(flags & 4)) throw new Error('远端文件缺少属性')
    const attributes = descriptor.readUInt32LE(36)
    if (attributes & 0x400) throw new Error('不接受远端链接或重解析点')
    const directory = !!(attributes & FORMAT_DIRECTORY)
    const actualSize = directory ? 0 : descriptor.readUInt32LE(64) * 2 ** 32 + descriptor.readUInt32LE(68)
    if ((!directory && !(flags & 0x40)) || !Number.isSafeInteger(actualSize) || actualSize > MAX_BYTES || (total += actualSize) > MAX_BYTES) throw new Error('单次文件传输最多支持 16 GiB')
    const key = name.toLowerCase()
    if (names.has(key)) throw new Error('远端文件名重复（含大小写冲突）')
    names.set(key, directory)
    entries.push({ name, directory, size: actualSize })
  }
  for (const entry of entries) {
    const parts = entry.name.toLowerCase().split('\\')
    for (let index = 1; index < parts.length; index++) if (names.get(parts.slice(0, index).join('\\')) === false) throw new Error('远端文件与目录名称冲突')
  }
  return entries
}

export function encodeFileDescriptors(entries: ReadonlyArray<{ name: string; directory: boolean; size: number }>): Buffer {
  if (!entries.length || entries.length > MAX_FILES) throw new Error('单次最多复制 4096 个文件和目录')
  const data = Buffer.alloc(4 + entries.length * DESCRIPTOR_SIZE)
  data.writeUInt32LE(entries.length)
  entries.forEach((entry, index) => {
    const offset = 4 + index * DESCRIPTOR_SIZE
    if (entry.name.includes('\0')) throw new Error('文件名包含空字符')
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BYTES) throw new Error('单次文件传输最多支持 16 GiB，文件大小必须有效')
    if (entry.name.length > 259) throw new Error('文件相对路径超过 RDP 的 259 字符限制')
    data.writeUInt32LE((4 | 0x40 | 0x80000000) >>> 0, offset)
    data.writeUInt32LE(entry.directory ? FORMAT_DIRECTORY : 0x80, offset + 36)
    data.writeUInt32LE(Math.floor(entry.size / 2 ** 32), offset + 64)
    data.writeUInt32LE(entry.size >>> 0, offset + 68)
    data.write(entry.name, offset + 72, 520, 'utf16le')
  })
  parseFileDescriptors(data)
  return data
}

export class NativeFileClipboard implements FileClipboard {
  private currentOffer?: VirtualFileOffer
  async offer(descriptors: Buffer, sequence: number, readFile: (index: number) => Promise<string>): Promise<VirtualFileOffer> {
    const offer = await offerVirtualFiles(this.directory, descriptors, sequence, readFile)
    const previous = this.currentOffer
    this.currentOffer = offer
    previous?.dispose()
    void offer.finished.then(() => { if (this.currentOffer === offer) this.currentOffer = undefined })
    return offer
  }
  constructor(private readonly directory: string) {}
  private run(mode: string, input?: Buffer): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(join(this.directory, 'omnidesk-freerdp.exe'), [mode], { cwd: this.directory, windowsHide: true, stdio: 'pipe' })
      const chunks: Buffer[] = []
      let length = 0
      const timer = setTimeout(() => { child.kill(); reject(new Error('本机文件剪贴板访问超时')) }, 10_000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.stderr.resume()
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 4 * 1024 * 1024) { child.kill(); reject(new Error('本机文件剪贴板过大')); return }
        chunks.push(chunk)
      })
      child.stdin.on('error', () => {})
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolvePromise(Buffer.concat(chunks))
        else reject(new Error(code === 4 ? '本机剪贴板已改变，未覆盖新复制的内容；请重新复制远端文件' : '无法访问本机文件剪贴板，请重新复制后重试'))
      })
      child.stdin.end(input)
    })
  }
  async read(): Promise<ClipboardSnapshot> {
    const data = await this.run('--clipboard-read-files')
    if (data.length < 8) throw new Error('本机文件剪贴板格式不正确')
    const sequence = data.readUInt32LE(0), count = data.readUInt32LE(4)
    if (count > MAX_FILES) throw new Error('单次最多复制 4096 个文件和目录')
    const paths: string[] = []
    let offset = 8
    for (let index = 0; index < count; index++) {
      if (offset + 4 > data.length) throw new Error('本机文件剪贴板数据不完整')
      const length = data.readUInt32LE(offset)
      offset += 4
      if (!length || length > 131072 || offset + length > data.length) throw new Error('本机文件路径不正确')
      const path = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, offset + length))
      if (!isAbsolute(path) || path.includes('\0')) throw new Error('本机文件路径不正确')
      paths.push(path)
      offset += length
    }
    if (offset !== data.length) throw new Error('本机文件剪贴板数据多余')
    return { sequence, paths }
  }
  async write(paths: string[], sequence: number): Promise<number> {
    const parts = paths.map(path => { const data = Buffer.from(path); return Buffer.concat([Buffer.from(nativeNumbers(data.length)), data]) })
    const payload = Buffer.concat([Buffer.from(nativeNumbers(sequence, paths.length)), ...parts])
    if (payload.length > 4 * 1024 * 1024) throw new Error('本机文件剪贴板过大')
    const result = await this.run('--clipboard-write-files', Buffer.concat([Buffer.from(nativeNumbers(payload.length)), payload]))
    if (result.length !== 4) throw new Error('本机文件剪贴板写入结果不正确')
    return result.readUInt32LE(0)
  }
}

export class FreeRdpFiles {
  private outgoing: Entry[] = []
  private outgoingRevision = 0
  private activeOutgoingId = 0
  private generation = 0
  private remoteFiles = false
  private remoteClipboard = false
  private remoteSequence = 0
  private requestId = 0
  private pending = new Map<number, Pending>()
  private descriptors?: Pending & { generation: number }
  private outgoingAck?: Pending & { id: number }
  private incoming?: AbortController
  private incomingGeneration = 0
  private disposed = false
  private serving = 0
  private servingQueue = Promise.resolve()
  private uploaded = 0
  private totalUpload = 0
  private lastProgress = 0
  private preparing = false
  private virtualOffer?: VirtualFileOffer
  private offeringGeneration = 0

  constructor(private readonly send: (packet: Uint8Array) => void, private readonly clipboard: FileClipboard, private readonly notify: (status: RdpFileTransferStatus) => void, private readonly cacheRoot = join(tmpdir(), 'omnidesk-rdp-files')) {}

  get hasOutgoing(): boolean { return this.outgoing.length > 0 }
  get hasRemoteFiles(): boolean { return this.remoteFiles }

  private status(direction: 'upload' | 'download', state: RdpFileTransferStatus['state'], completed: number, total: number, message: string): void {
    if (this.disposed) return
    if (state === 'progress' && Date.now() - this.lastProgress < 150) return
    this.lastProgress = Date.now()
    this.notify({ direction, state, completed, total, message: message.slice(0, 1024) })
  }
  private wait(map?: Map<number, Pending>, id?: number): { pending: Pending; promise: Promise<Buffer> } {
    let pending!: Pending
    const promise = new Promise<Buffer>((resolvePromise, reject) => {
      pending = { resolve: resolvePromise, reject, timer: setTimeout(() => { if (map && id !== undefined) map.delete(id); reject(new Error('文件传输等待服务器响应超时，请重新复制后重试')) }, TIMEOUT) }
    })
    if (map && id !== undefined) map.set(id, pending)
    return { pending, promise }
  }
  private settle(pending: Pending | undefined, data?: Buffer, error?: Error): void {
    if (!pending) return
    clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve(data ?? Buffer.alloc(0))
  }
  private async closeEntries(entries: Entry[]): Promise<void> { await Promise.all(entries.map(entry => entry.handle?.close().catch(() => {}))) }

  async publishLocal(allowed: () => boolean): Promise<boolean | 'remote'> {
    if (this.disposed || !allowed()) throw new Error('请聚焦远程桌面后粘贴')
    if (this.preparing) throw new Error('正在准备文件，请稍候再粘贴')
    this.preparing = true
    const revision = ++this.outgoingRevision
    const entries: Entry[] = []
    let adopted = false
    try {
      const snapshot = await this.clipboard.read()
      if (this.disposed || !allowed() || revision !== this.outgoingRevision) throw new Error('文件粘贴已取消')
      if (this.remoteClipboard && snapshot.sequence === this.remoteSequence) return 'remote'
      this.remoteClipboard = false
      this.remoteFiles = false
      if (!snapshot.paths.length) {
        const previous = this.outgoing
        this.outgoing = []
        this.activeOutgoingId = 0
        await this.closeEntries(previous)
        this.send(nativeCommand(8, nativeNumbers(5)))
        return false
      }
      const visit = async (path: string, name: string): Promise<void> => {
        if (this.disposed || !allowed() || revision !== this.outgoingRevision) throw new Error('文件粘贴已取消')
        if (entries.length >= MAX_FILES) throw new Error('单次最多复制 4096 个文件和目录')
        const info = await lstat(path)
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('不支持复制符号链接、重解析点或特殊文件')
        if (info.isDirectory()) {
          entries.push({ name, directory: true, size: 0 })
          for (const child of await readdir(path)) await visit(join(path, child), `${name}\\${child}`)
        } else {
          const handle = await open(path, constants.O_RDONLY)
          const opened = await handle.stat()
          if (!opened.isFile() || opened.ino !== info.ino || opened.size !== info.size) { await handle.close(); throw new Error('文件已改变，请重新复制') }
          entries.push({ name, directory: false, size: opened.size, handle })
        }
      }
      for (const path of snapshot.paths) await visit(path, basename(path))
      const descriptors = encodeFileDescriptors(entries)
      const current = await this.clipboard.read()
      if (current.sequence !== snapshot.sequence || this.disposed || !allowed() || revision !== this.outgoingRevision) throw new Error('剪贴板已改变，请重新粘贴')
      const previous = this.outgoing
      this.outgoing = entries
      adopted = true
      await this.closeEntries(previous)
      this.uploaded = 0
      this.totalUpload = entries.reduce((total, entry) => total + entry.size, 0)
      const waiting = this.wait()
      const id = this.requestId = (this.requestId + 1) >>> 0
      this.activeOutgoingId = id
      this.outgoingAck = { ...waiting.pending, id }
      this.send(nativeCommand(8, nativeNumbers(1, id), descriptors))
      await waiting.promise
      this.outgoingAck = undefined
      if (this.disposed || !allowed() || revision !== this.outgoingRevision) throw new Error('文件粘贴已取消')
      this.status('upload', 'ready', 0, this.totalUpload, `已准备 ${entries.length} 个文件/目录，等待远端粘贴`)
      return true
    } catch (error) {
      if (adopted && this.outgoing === entries) { this.outgoing = []; this.activeOutgoingId = 0; this.send(nativeCommand(8, nativeNumbers(5))) }
      throw error
    } finally {
      if (!adopted || this.outgoing !== entries) await this.closeEntries(entries)
      this.preparing = false
    }
  }

  handle(packet: Uint8Array): void {
    if (this.disposed || packet.length < 5 || packet[0] !== 9) return
    const data = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength)
    const action = data.readUInt32LE(1)
    if (action === 1 && data.length === 17) {
      this.generation = data.readUInt32LE(5)
      this.remoteClipboard = true
      this.remoteFiles = !!data.readUInt32LE(9)
      this.remoteSequence = data.readUInt32LE(13)
      this.cancelPreparation()
      this.outgoingRevision++
      const outgoing = this.outgoing
      this.outgoing = []
      this.activeOutgoingId = 0
      void this.closeEntries(outgoing)
      this.cancelIncoming()
      this.notify({ direction: 'download', state: this.remoteFiles ? 'available' : 'unavailable', completed: 0, total: 0, message: '' })
    } else if (action === 2 && data.length >= 13) {
      if (this.descriptors?.generation !== data.readUInt32LE(5)) return
      const pending = this.descriptors
      this.descriptors = undefined
      this.settle(pending, data.subarray(13), data.readUInt32LE(9) ? undefined : new Error('无法读取远端文件列表，请重新复制'))
    } else if (action === 3 && data.length === 33) {
      const id = data.readUInt32LE(5)
      const request = Buffer.concat([data.subarray(0, 5), data.subarray(9)])
      if (!id || id !== this.activeOutgoingId || this.serving >= 16) { this.respond(request.readUInt32LE(5), false); return }
      const revision = this.outgoingRevision
      this.serving++
      this.servingQueue = this.servingQueue.then(() => revision === this.outgoingRevision && id === this.activeOutgoingId ? this.serve(request) : this.respond(request.readUInt32LE(5), false)).catch(() => this.respond(request.readUInt32LE(5), false)).finally(() => { this.serving-- })
    } else if (action === 4 && data.length >= 13 && data.length <= CHUNK + 13) {
      const stream = data.readUInt32LE(5)
      const pending = this.pending.get(stream)
      this.pending.delete(stream)
      this.settle(pending, data.subarray(13), data.readUInt32LE(9) ? undefined : new Error('服务器拒绝读取文件，文件可能已移动或剪贴板已改变'))
    } else if (action === 5 && data.length === 13 && this.outgoingAck?.id === data.readUInt32LE(5)) {
      const pending = this.outgoingAck
      this.outgoingAck = undefined
      this.settle(pending, undefined, data.readUInt32LE(9) ? undefined : new Error('服务器未启用文件剪贴板，或未协商大文件支持；请检查剪贴板重定向策略'))
    }
  }

  private respond(stream: number, success: boolean, data = Buffer.alloc(0)): void {
    if (!this.disposed) this.send(nativeCommand(8, nativeNumbers(4, stream, success ? 1 : 0), data))
  }
  private async serve(request: Buffer): Promise<void> {
    if (this.disposed) return
    const stream = request.readUInt32LE(5), index = request.readUInt32LE(9), flags = request.readUInt32LE(13)
    const position = request.readUInt32LE(17) + request.readUInt32LE(21) * 2 ** 32
    const length = request.readUInt32LE(25)
    const entry = this.outgoing[index]
    const revision = this.outgoingRevision
    if (!entry?.handle || entry.directory || !Number.isSafeInteger(position) || (flags !== 1 && flags !== 2)) { this.respond(stream, false); return }
    if (flags === 1) {
      const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(entry.size)); this.respond(stream, true, size)
      if (!entry.size) entry.complete = true
      this.uploadProgress()
      return
    }
    if (!length || length > 4 * 1024 * 1024 - 128 || position > entry.size) { this.respond(stream, false); return }
    const data = Buffer.alloc(Math.min(length, entry.size - position))
    const { bytesRead } = await entry.handle.read(data, 0, data.length, position)
    if (revision !== this.outgoingRevision || this.outgoing[index] !== entry) { this.respond(stream, false); return }
    this.respond(stream, true, data.subarray(0, bytesRead))
    const ranges = [...(entry.ranges ?? []), [position, position + bytesRead] as [number, number]].sort((first, second) => first[0] - second[0])
    const merged: Array<[number, number]> = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous && previous[1] >= range[0]) previous[1] = Math.max(previous[1], range[1])
      else merged.push(range)
    }
    if (merged.length <= 128) {
      const transferred = merged.reduce((total, range) => total + range[1] - range[0], 0)
      this.uploaded += transferred - (entry.transferred ?? 0)
      entry.transferred = transferred
      entry.ranges = merged
      entry.complete = transferred === entry.size
    }
    this.uploadProgress()
  }

  private uploadProgress(): void {
    const complete = this.outgoing.length > 0 && this.outgoing.every(entry => entry.directory || entry.complete)
    this.status('upload', complete ? 'complete' : 'progress', this.uploaded, this.totalUpload, complete ? '文件数据已传给远端，请以远端文件管理器的粘贴结果为准' : '正在向远端传输文件')
  }

  async offerRemote(): Promise<void> {
    if (!this.clipboard.offer || this.disposed || !this.remoteFiles || !this.generation || this.offeringGeneration === this.generation) return
    const generation = this.generation, sequence = this.remoteSequence
    this.offeringGeneration = generation
    const controller = new AbortController()
    this.incoming = controller
    const check = () => { if (this.disposed || controller.signal.aborted || generation !== this.generation) throw new Error('文件粘贴已取消，请重新复制') }
    let directory: string | undefined
    try {
      const waiting = this.wait()
      this.descriptors = { ...waiting.pending, generation }
      this.send(nativeCommand(8, nativeNumbers(2, generation)))
      const descriptors = await waiting.promise
      const entries = parseFileDescriptors(descriptors)
      check()
      const total = entries.reduce((sum, entry) => sum + entry.size, 0)
      let completed = 0
      const downloads = new Map<number, Promise<string>>()
      const readFile = (index: number): Promise<string> => {
        const existing = downloads.get(index)
        if (existing) return existing
        const downloading = (async () => {
          check()
          const entry = entries[index]
          if (!entry || entry.directory) throw new Error('文件索引无效')
          if (!directory) {
            await mkdir(this.cacheRoot, { recursive: true })
            await pruneCache(this.cacheRoot, [])
            const free = await statfs(this.cacheRoot)
            if (Number(free.bavail) * Number(free.bsize) < total + 512 * 1024 ** 2) throw new Error('本机临时目录空间不足（需保留 512 MiB 空间）')
            directory = await mkdtemp(join(this.cacheRoot, 'copy-')); activeCopies.add(directory)
          }
          const target = join(directory, String(index))
          this.status('download', 'progress', completed, total, '正在粘贴到本机：' + entry.name)
          const size = await this.requestContent(index, 1, 0, 8)
          if (size.length !== 8 || size.readBigUInt64LE() !== BigInt(entry.size)) throw new Error('远端文件大小已改变，请重新复制')
          const handle = await open(target, 'wx')
          let complete = false
          try {
            for (let offset = 0; offset < entry.size;) {
              check()
              const length = Math.min(CHUNK, entry.size - offset), data = await this.requestContent(index, 2, offset, length)
              if (!data.length || data.length > length) throw new Error('远端返回无效的文件长度')
              for (let written = 0; written < data.length;) { const result = await handle.write(data, written, data.length - written, offset + written); if (!result.bytesWritten) throw new Error('写入本机文件失败'); written += result.bytesWritten }
              offset += data.length; completed += data.length
              this.status('download', 'progress', completed, total, '正在粘贴到本机：' + entry.name)
            }
            check(); complete = true
          } finally { await handle.close(); if (!complete) await rm(target, { force: true }).catch(() => {}) }
          if (completed === total) this.status('download', 'complete', completed, total, '文件已传输，正在由本机完成粘贴')
          return target
        })().catch(error => { this.status('download', controller.signal.aborted ? 'cancelled' : 'error', completed, total, error instanceof Error ? error.message : '文件传输失败'); throw error })
        downloads.set(index, downloading)
        return downloading
      }
      const offer = await this.clipboard.offer(descriptors, sequence, readFile)
      try { check() } catch (error) { offer.dispose(); throw error }
      this.virtualOffer = offer; this.remoteSequence = offer.sequence
      void offer.finished.then(() => {
        if (directory) activeCopies.delete(directory)
        if (this.virtualOffer === offer) { this.cancelIncoming(); if (this.incoming === controller) this.incoming = undefined }
      })
    } catch (error) {
      if (this.offeringGeneration === generation) this.offeringGeneration = 0
      if (this.incoming === controller) this.incoming = undefined
      if (!controller.signal.aborted && generation === this.generation && !this.disposed) this.status('download', 'error', 0, 0, error instanceof Error ? error.message : '文件剪贴板准备失败，请重新复制')
    }
  }

  async receiveRemote(allowed: () => boolean): Promise<void> {
    if (this.disposed || !allowed() || !this.generation) return
    if (!this.remoteFiles) throw new Error('远端剪贴板没有可接收的文件，请先在远端复制文件')
    if (this.incomingGeneration === this.generation) return
    this.incomingGeneration = this.generation
    const generation = this.generation
    const controller = new AbortController()
    this.incoming = controller
    let directory: string | undefined
    let keep = false
    const check = () => { if (this.disposed || controller.signal.aborted || generation !== this.generation) throw new Error('文件下载已取消') }
    try {
      const snapshot = await this.clipboard.read()
      check()
      if (!allowed()) return
      const waiting = this.wait()
      this.descriptors = { ...waiting.pending, generation }
      this.send(nativeCommand(8, nativeNumbers(2, generation)))
      const entries = parseFileDescriptors(await waiting.promise)
      check()
      const total = entries.reduce((sum, entry) => sum + entry.size, 0)
      await mkdir(this.cacheRoot, { recursive: true })
      await pruneCache(this.cacheRoot, snapshot.paths)
      const free = await statfs(this.cacheRoot)
      if (Number(free.bavail) * Number(free.bsize) < total + 512 * 1024 ** 2) throw new Error('本机临时目录空间不足，未下载文件（需保留 512 MiB 空间）')
      directory = await mkdtemp(join(this.cacheRoot, 'copy-'))
      activeCopies.add(directory)
      this.status('download', 'progress', 0, total, `正在下载 ${entries.length} 个文件/目录，完成后可在本机粘贴`)
      let completed = 0
      for (let index = 0; index < entries.length; index++) {
        check()
        const entry = entries[index]
        const target = resolve(directory, ...entry.name.split('\\'))
        const inside = relative(directory, target)
        if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('远端文件路径越界')
        if (entry.directory) { await mkdir(target, { recursive: true }); continue }
        await mkdir(resolve(target, '..'), { recursive: true })
        const handle = await open(target, 'wx')
        try {
          const size = await this.requestContent(index, 1, 0, 8)
          if (size.length !== 8 || size.readBigUInt64LE() !== BigInt(entry.size)) throw new Error('远端文件大小已改变，请重新复制')
          let offset = 0
          while (offset < entry.size) {
            check()
            const length = Math.min(CHUNK, entry.size - offset)
            const data = await this.requestContent(index, 2, offset, length)
            if (!data.length || data.length > length) throw new Error('远端返回的文件数据长度不正确')
            let written = 0
            while (written < data.length) { const result = await handle.write(data, written, data.length - written, offset + written); if (!result.bytesWritten) throw new Error('写入本机文件失败'); written += result.bytesWritten }
            offset += data.length
            completed += data.length
            check()
            this.status('download', 'progress', completed, total, '正在下载远端文件，完成后可在本机粘贴')
          }
        } finally { await handle.close() }
      }
      check()
      const roots = new Map<string, string>()
      for (const entry of entries) { const root = entry.name.split('\\')[0]; if (!roots.has(root.toLowerCase())) roots.set(root.toLowerCase(), root) }
      const paths = [...roots.values()].map(name => join(directory!, name))
      const writtenSequence = await this.clipboard.write(paths, snapshot.sequence)
      if (this.remoteClipboard && this.remoteSequence === snapshot.sequence) this.remoteSequence = writtenSequence
      keep = true
      if (generation === this.generation && !controller.signal.aborted) this.status('download', 'complete', total, total, '文件已下载，可在本机文件夹中按 Ctrl+V 粘贴')
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.status('download', controller.signal.aborted ? 'cancelled' : 'error', 0, 0, error instanceof Error ? error.message : '文件下载失败')
    } finally {
      if (this.incoming === controller) this.incoming = undefined
      if (!keep && this.incomingGeneration === generation) this.incomingGeneration = 0
      if (directory) {
        if (!keep) await removeCachedCopy(this.cacheRoot, directory).catch(() => {})
        activeCopies.delete(directory)
      }
    }
  }

  private async requestContent(index: number, flags: number, position: number, length: number): Promise<Buffer> {
    const stream = this.requestId = (this.requestId + 1) >>> 0
    const waiting = this.wait(this.pending, stream)
    this.send(nativeCommand(8, nativeNumbers(3, stream, index, flags, position >>> 0, Math.floor(position / 2 ** 32), length)))
    return waiting.promise
  }
  private cancelIncoming(): void {
    this.virtualOffer?.dispose()
    this.virtualOffer = undefined
    this.offeringGeneration = 0
    this.incoming?.abort()
    this.settle(this.descriptors, undefined, new Error('文件下载已取消'))
    this.descriptors = undefined
    for (const pending of this.pending.values()) this.settle(pending, undefined, new Error('文件下载已取消'))
    this.pending.clear()
  }
  cancelDownload(): void { this.cancelIncoming() }
  cancelPreparation(): void {
    if (!this.preparing) return
    this.outgoingRevision++
    this.settle(this.outgoingAck, undefined, new Error('窗口或标签已切换，文件粘贴已取消'))
    this.outgoingAck = undefined
  }
  cancel(): void {
    this.cancelIncoming()
    this.outgoingRevision++
    const entries = this.outgoing
    this.outgoing = []
    this.activeOutgoingId = 0
    void this.closeEntries(entries)
    this.settle(this.outgoingAck, undefined, new Error('文件粘贴已取消'))
    this.outgoingAck = undefined
    if (!this.disposed) this.send(nativeCommand(8, nativeNumbers(5)))
    this.status('upload', 'cancelled', 0, 0, '文件传输已取消')
  }
  dispose(): void { this.disposed = true; this.cancel() }
}
