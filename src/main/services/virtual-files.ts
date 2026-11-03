import { spawn } from 'node:child_process'
import { join, isAbsolute } from 'node:path'
import { nativeEnvironment } from './freerdp-runtime.js'

export interface VirtualFileOffer { sequence: number; dispose(): void; finished: Promise<void> }

/** Native OLE data object: listing formats never reads file contents. */
export function offerVirtualFiles(directory: string, descriptors: Buffer, sequence: number, readFile: (index: number) => Promise<string>, mode: 'clipboard' | 'drag' = 'clipboard'): Promise<VirtualFileOffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(directory, 'omnidesk-freerdp.exe'), ['--virtual-' + mode], { cwd: directory, env: nativeEnvironment(directory), windowsHide: true, stdio: 'pipe' })
    let disposed = false, ready = false, buffered = Buffer.alloc(0)
    let finish!: () => void
    const finished = new Promise<void>(resolveFinished => { finish = resolveFinished })
    const dispose = () => { if (disposed) return; disposed = true; child.stdin.destroy(); child.kill(); finish() }
    const fail = (error: Error) => { clearTimeout(timer); if (!ready) reject(error); dispose() }
    const timer = setTimeout(() => fail(new Error('本机文件拖拽与剪贴板初始化超时')), 15_000)
    child.on('error', fail)
    child.stderr.resume()
    child.stdin.on('error', error => { if (!disposed) fail(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (!ready) reject(new Error(code === 4 ? '剪贴板已改变，已保留新复制的内容，请重新复制远端文件' : '无法初始化本机文件拖拽与剪贴板'))
      disposed = true; finish()
    })
    const reply = (success: boolean, path = '') => {
      if (disposed || child.stdin.destroyed) return
      const data = Buffer.from(path, 'utf8'), message = Buffer.alloc(8 + data.length)
      message.writeUInt32LE(4 + data.length); message.writeUInt32LE(success ? 1 : 0, 4); data.copy(message, 8)
      child.stdin.write(message)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE()
        if (length !== 8) { fail(new Error('本机文件助手返回无效数据')); return }
        if (buffered.length < length + 4) return
        const message = buffered.subarray(4, length + 4); buffered = buffered.subarray(length + 4)
        const action = message.readUInt32LE(), value = message.readUInt32LE(4)
        if (action === 1 && !ready) {
          ready = true; clearTimeout(timer); resolve({ sequence: value, dispose, finished })
        } else if (action === 2 && ready) {
          void readFile(value).then(path => { if (!isAbsolute(path) || path.includes('\0')) throw new Error('本机文件路径无效'); reply(true, path) }).catch(() => reply(false))
        } else if (action !== 3) { fail(new Error('本机文件助手返回未知请求')); return }
      }
    })
    const initial = Buffer.alloc(8 + descriptors.length)
    initial.writeUInt32LE(4 + descriptors.length); initial.writeUInt32LE(sequence, 4); descriptors.copy(initial, 8)
    child.stdin.write(initial)
  })
}
