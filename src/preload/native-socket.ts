import { WebSocket } from 'ws'
import { FREERDP_MAX_COMMAND, FREERDP_MAX_PACKET } from '@shared/freerdp-protocol'
import type { OpenNativeSocket } from '@shared/native-socket'

declare const window: { addEventListener(event: 'unload', listener: () => void): void }

const sockets = new Set<WebSocket>()
window.addEventListener('unload', () => { for (const socket of sockets) socket.terminate(); sockets.clear() })

// Only the authenticated, single-use FreeRDP loopback endpoint is exposed.
// Node's socket does not use Chromium's system proxy or local-network permissions.
export const openNativeSocket: OpenNativeSocket = (address, receive) => {
  const url = new URL(address)
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash || !/^\/freerdp\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url.pathname) || [...url.searchParams].length !== 1 || !/^[a-f0-9]{32}$/.test(url.searchParams.get('token') ?? '')) throw new Error('FreeRDP 本机通道地址无效，请重新连接')
  if (typeof receive !== 'function') throw new Error('FreeRDP 本机通道回调无效')
  const socket = new WebSocket(url, { perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10000, maxPayload: FREERDP_MAX_PACKET })
  sockets.add(socket)
  socket.on('open', () => receive({ kind: 'open' }))
  socket.on('message', (data, binary) => {
    if (!binary || !Buffer.isBuffer(data)) { socket.terminate(); return }
    receive({ kind: 'data', data: new Uint8Array(data) })
  })
  socket.on('error', (error: NodeJS.ErrnoException) => {
    const code = /^[A-Z0-9_]{1,64}$/.test(error.code ?? '') ? error.code : 'HANDSHAKE_FAILED'
    const reason = code === 'ECONNREFUSED' ? '本机监听服务未就绪或已退出' : /^(EACCES|EPERM)$/.test(code!) ? '本机连接被系统或安全软件阻止' : '本机会话握手失败，请关闭此标签后重新连接'
    receive({ kind: 'error', message: `FreeRDP 本机通道连接失败：${reason}（${code}）` })
  })
  socket.on('close', code => { sockets.delete(socket); receive({ kind: 'close', code }) })
  return {
    send(data) {
      if (!(data instanceof Uint8Array) || !data.length || data.length > FREERDP_MAX_COMMAND) throw new Error('FreeRDP 本机输入数据无效')
      if (socket.readyState !== WebSocket.OPEN) throw new Error('FreeRDP 本机通道尚未就绪或已关闭')
      if (socket.bufferedAmount > 8 * 1024 * 1024) throw new Error('FreeRDP 输入积压，请稍后重试')
      socket.send(data, { binary: true })
    },
    close() { if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close() }
  }
}
