export const REMOTE_PATH_MIME = 'application/x-omnidesk-remote-path'

export function remotePathArgument(data: string, sessionId: string): string {
  let payload: { sessionId?: unknown; path?: unknown }
  try { payload = JSON.parse(data) } catch { throw new Error('无法读取拖拽路径，请从远程文件列表重新拖入') }
  if (!payload || typeof payload !== 'object' || payload.sessionId !== sessionId) throw new Error('只能拖入当前 SSH 会话的远程文件，不能混用其他服务器的路径')
  const path = payload.path
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 8192 || /[\x00-\x1f\x7f]/.test(path)) throw new Error('路径包含不支持的控制字符，未插入终端')
  return (/^[a-zA-Z0-9_/@%+=:,.-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`) + ' '
}
