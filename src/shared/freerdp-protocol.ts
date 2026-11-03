export const FREERDP_MAX_PACKET = 16 * 1024 * 1024 * 4 + 17
export const FREERDP_MAX_COMMAND = 4 * 1024 * 1024 + 128

export interface RdpFileTransferStatus {
  direction: 'upload' | 'download'
  state: 'available' | 'unavailable' | 'ready' | 'progress' | 'complete' | 'cancelled' | 'error'
  completed: number
  total: number
  message: string
}

export function nativeNumbers(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true))
  return bytes
}

export function nativeCommand(kind: number, ...parts: Uint8Array[]): Uint8Array {
  const data = new Uint8Array(1 + parts.reduce((total, part) => total + part.length, 0))
  data[0] = kind
  let offset = 1
  for (const part of parts) { data.set(part, offset); offset += part.length }
  return data
}

export function nativeFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 4)
  frame.set(nativeNumbers(payload.length))
  frame.set(payload, 4)
  return frame
}

export class NativePacketDecoder {
  private header = new Uint8Array(4)
  private offset = 0
  private payload: Uint8Array | undefined

  constructor(private readonly receive: (payload: Uint8Array) => void) {}

  push(chunk: Uint8Array): void {
    let position = 0
    while (position < chunk.length) {
      const target = this.payload ?? this.header
      const count = Math.min(target.length - this.offset, chunk.length - position)
      target.set(chunk.subarray(position, position + count), this.offset)
      position += count
      this.offset += count
      if (this.offset !== target.length) continue
      this.offset = 0
      if (this.payload) {
        const packet = this.payload
        this.payload = undefined
        this.receive(packet)
      } else {
        const length = new DataView(this.header.buffer).getUint32(0, true)
        if (!length || length > FREERDP_MAX_PACKET) throw new Error('FreeRDP 辅助进程返回了无效数据长度')
        this.payload = new Uint8Array(length)
      }
    }
  }
}
