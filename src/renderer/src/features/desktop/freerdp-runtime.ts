import type { NativeSocket, OpenNativeSocket } from '@shared/native-socket'
import { nativeCommand, nativeNumbers } from '@shared/freerdp-protocol'
import type { DesktopRuntime, DesktopEvent, DesktopTransaction, DesktopClipboard, DesktopSession } from './desktop-runtime'

class NativeEvent implements DesktopEvent {
  constructor(readonly entries: number[][]) {}
  free(): void {}
  static keyPressed(scan: number) { return new NativeEvent([[1, scan, 0]]) }
  static keyReleased(scan: number) { return new NativeEvent([[2, scan, 0]]) }
  static unicode(value: string, kind: number) {
    return new NativeEvent(Array.from({ length: value.length }, (_, index) => [kind, value.charCodeAt(index), 0]))
  }
  static unicodePressed(value: string) { return this.unicode(value, 3) }
  static unicodeReleased(value: string) { return this.unicode(value, 4) }
  static mouseMove(x: number, y: number) { return new NativeEvent([[5, x, y]]) }
  static mouseButtonPressed(button: number) { return new NativeEvent([[6, button, 0]]) }
  static mouseButtonReleased(button: number) { return new NativeEvent([[7, button, 0]]) }
  static wheelRotations(vertical: boolean, amount: number, unit: number) { return new NativeEvent([[8, Math.max(-255, Math.min(255, Math.trunc(amount * (unit === 0 ? 1 : 120)))), vertical ? 0 : 1]]) }
}
class NativeTransaction implements DesktopTransaction {
  entries: number[][] = []
  addEvent(event: DesktopEvent): void {
    if (!(event instanceof NativeEvent)) throw new Error('FreeRDP 输入事件类型不正确')
    this.entries.push(...event.entries)
  }
  free(): void { this.entries = [] }
}
class NativeClipboard implements DesktopClipboard {
  text = ''
  addText(_mime: string, text: string): void { this.text = text }
  free(): void { this.text = '' }
}

// Standalone renderer fixtures may supply a browser transport. The application
// supplies the restricted preload transport, which connects directly via Node.
const browserSocket: OpenNativeSocket = (address, receive) => {
  const socket = new WebSocket(address)
  socket.binaryType = 'arraybuffer'
  socket.onopen = () => receive({ kind: 'open' })
  socket.onmessage = event => { if (event.data instanceof ArrayBuffer) receive({ kind: 'data', data: new Uint8Array(event.data) }) }
  socket.onerror = () => receive({ kind: 'error', message: 'FreeRDP 本机 WebSocket 连接失败，请检查本机代理及通信限制' })
  socket.onclose = event => receive({ kind: 'close', code: event.code })
  return { send: data => socket.send(data), close: () => socket.close() }
}

export function createFreeRdpRuntime(openSocket: OpenNativeSocket = browserSocket): DesktopRuntime {
  const sessions = new Set<NativeSession>()
  class NativeSession implements DesktopSession {
    private ended = false
    private ready = false
    private reconnecting = false
    private result: Promise<{ reason(): string; free(): void }>
    private resolve!: (value: { reason(): string; free(): void }) => void
    private reject!: (error: Error) => void
    private failConnect!: (error: Error) => void
    readonly connected: Promise<NativeSession>
    private socket: NativeSocket
    private socketOpen = false

    constructor(private readonly builder: NativeBuilder) {
      const canvas = builder.canvas!
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('无法初始化 FreeRDP 画布')
      this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
      void this.result.catch(() => {})
      let accept!: (session: NativeSession) => void
      this.connected = new Promise((resolve, reject) => { accept = resolve; this.failConnect = reject })
      sessions.add(this)
      this.socket = openSocket(builder.address, event => {
        if (this.ended) return
        if (event.kind === 'open') { this.socketOpen = true; this.resize(builder.size.width, builder.size.height, 100); return }
        if (event.kind === 'error') { this.fail(new Error(event.message)); return }
        if (event.kind === 'close') { this.fail(new Error(`FreeRDP 本机会话通道已关闭（${event.code}）`)); return }
        try {
          const bytes = event.data
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          const number = (offset: number) => view.getUint32(offset, true)
          if (bytes[0] === 1 && bytes.length === 9) {
            const width = number(1), height = number(5)
            if (width < 200 || height < 200 || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024) throw new Error('画布尺寸不正确')
            canvas.width = width
            canvas.height = height
            if (!this.ready) { this.ready = true; accept(this); queueMicrotask(() => builder.forceClipboard?.()) }
          } else if (bytes[0] === 2 && bytes.length >= 17) {
            const left = number(1), top = number(5), width = number(9), height = number(13)
            if (!width || !height || left + width > canvas.width || top + height > canvas.height || bytes.length !== 17 + width * height * 4) throw new Error('画面矩形不正确')
            context.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 17, bytes.byteLength - 17), width, height), left, top)
          } else if (bytes[0] === 3 && bytes.length >= 5) {
            this.fail(new Error(`FreeRDP：${new TextDecoder().decode(bytes.subarray(5)) || `错误代码 ${number(1)}`}`))
          } else if (bytes[0] === 4 && bytes.length === 5) {
            if (number(1)) this.fail(new Error(`FreeRDP 会话结束，错误代码 ${number(1)}`))
            else this.finish()
          } else if (bytes[0] === 5 && bytes.length <= 4 * 1024 * 1024 + 1) {
            const text = new TextDecoder().decode(bytes.subarray(1))
            builder.clipboard?.({ items: () => [{ mimeType: () => 'text/plain', value: () => text }] })
          } else if (bytes[0] === 7 && bytes.length >= 17) {
            const width = number(1), height = number(5), hotspotX = number(9), hotspotY = number(13)
            if (!width || !height || width > 384 || height > 384 || hotspotX >= width || hotspotY >= height || bytes.length !== 17 + width * height * 4) throw new Error('光标数据不正确')
            if (width > 128 || height > 128) { builder.cursor?.('default'); return }
            const pointer = document.createElement('canvas')
            pointer.width = width; pointer.height = height
            pointer.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 17, bytes.byteLength - 17), width, height), 0, 0)
            builder.cursor?.('url', pointer.toDataURL('image/png'), hotspotX, hotspotY)
          } else if (bytes[0] === 8 && bytes.length === 2) builder.cursor?.(bytes[1] ? 'hidden' : 'default')
          else if (bytes[0] === 10 && bytes.length < 8192) {
            const status = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
            builder.clipboard?.({ items: () => [{ mimeType: () => 'application/x-omnidesk-file-transfer', value: () => status }] })
          }
          else if (bytes[0] === 11 && bytes.length === 9 && number(1) <= 1) {
            this.reconnecting = number(1) === 1
            builder.connectionState?.({ reconnecting: this.reconnecting, attempt: number(5) })
          } else throw new Error('未知或损坏的事件')
        } catch (error) { this.fail(new Error(`FreeRDP 画面处理失败：${error instanceof Error ? error.message : '数据不正确'}`)) }
      })
    }
    private send(data: Uint8Array): boolean {
      if (this.ended || !this.socketOpen || this.reconnecting) return false
      try { this.socket.send(data); return true }
      catch (error) { this.fail(error instanceof Error ? error : new Error('FreeRDP 本机输入发送失败')); return false }
    }
    private fail(error: Error): void {
      if (this.ended) return
      this.ended = true
      this.failConnect(error)
      this.reject(error)
      this.socket.close()
      sessions.delete(this)
    }
    private finish(): void {
      if (!this.ready) { this.fail(new Error('FreeRDP 未完成连接')); return }
      if (this.ended) return
      this.ended = true
      this.resolve({ reason: () => '远程桌面会话已结束', free() {} })
      this.socket.close()
      sessions.delete(this)
    }
    applyInputs(transaction: DesktopTransaction): void {
      if (!(transaction instanceof NativeTransaction)) throw new Error('FreeRDP 输入事务不正确')
      try { this.send(nativeCommand(2, nativeNumbers(transaction.entries.length, ...transaction.entries.flat()))) }
      finally { transaction.free() }
    }
    async onClipboardPaste(content: DesktopClipboard): Promise<void> {
      if (!(content instanceof NativeClipboard)) throw new Error('FreeRDP 剪贴板类型不正确')
      if (this.ended || !this.ready || !this.socketOpen || this.reconnecting) throw new Error('剪贴板通道正在恢复或已关闭，请稍后重试')
      if (content.text.length > 1024 * 1024) throw new Error('剪贴板文本超过 1M 字符')
      if (!this.send(nativeCommand(4, new TextEncoder().encode(content.text)))) throw new Error('剪贴板发送失败，请重新连接后重试')
    }
    releaseAllInputs(): void { this.send(nativeCommand(7)) }
    resize(width: number, height: number, scale = 100): void { this.send(nativeCommand(3, nativeNumbers(width, height, scale ?? 100))) }
    run() { return this.result }
    shutdown(): void { if (this.ready) this.finish(); else this.fail(new Error('FreeRDP 连接已取消')) }
    free(): void { this.shutdown() }
  }
  class NativeBuilder {
    address = ''
    canvas?: HTMLCanvasElement
    size = { width: 1280, height: 720 }
    cursor?: (kind: string, data?: string, x?: number, y?: number) => void
    clipboard?: (data: unknown) => void
    forceClipboard?: () => void
    connectionState?: (state: { reconnecting: boolean; attempt: number }) => void
    connectionStateChanged(callback: NonNullable<NativeBuilder['connectionState']>) { this.connectionState = callback; return this }
    username(_value: string) { return this }
    password(_value: string) { return this }
    destination(_value: string) { return this }
    serverDomain(_value: string) { return this }
    extension(_value: unknown) { return this }
    authToken(_value: string) { return this }
    proxyAddress(value: string) { this.address = value; return this }
    renderCanvas(value: HTMLCanvasElement) { this.canvas = value; return this }
    setCursorStyleCallbackContext(_value: HTMLCanvasElement) { return this }
    setCursorStyleCallback(callback: typeof this.cursor) { this.cursor = callback; return this }
    desktopSize(value: { width: number; height: number }) { this.size = value; return this }
    forceClipboardUpdateCallback(callback: () => void) { this.forceClipboard = callback; return this }
    remoteClipboardChangedCallback(callback: (data: unknown) => void) { this.clipboard = callback; return this }
    async connect(): Promise<DesktopSession> {
      const address = new URL(this.address)
      if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || !this.canvas) throw new Error('FreeRDP 必须使用本机安全会话通道')
      return new NativeSession(this).connected
    }
    free(): void {}
  }
  return {
    SessionBuilder: NativeBuilder,
    DesktopSize: class { constructor(public width: number, public height: number) {} },
    DeviceEvent: NativeEvent, InputTransaction: NativeTransaction, ClipboardData: NativeClipboard,
    enableCredssp: () => undefined, displayControl: () => undefined,
    runtime: { dispose() { for (const session of sessions) session.shutdown() } }
  }
}
