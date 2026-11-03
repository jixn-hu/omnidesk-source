export type NativeSocketEvent =
  | { kind: 'open' }
  | { kind: 'data'; data: Uint8Array<ArrayBuffer> }
  | { kind: 'error'; message: string }
  | { kind: 'close'; code: number }

export interface NativeSocket {
  send(data: Uint8Array): void
  close(): void
}
export type OpenNativeSocket = (address: string, receive: (event: NativeSocketEvent) => void) => NativeSocket
