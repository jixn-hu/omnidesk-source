export const DEFAULT_WEBDAV_FILENAME = 'OmniDesk.odbackup'

export interface WebDavLocation {
  serverUrl: string
  directory: string
  filename: string
}

export function splitWebDavLocation(url: string, serverUrl?: string): WebDavLocation {
  if (!url) return { serverUrl: '', directory: '', filename: DEFAULT_WEBDAV_FILENAME }
  const base = serverUrl && url.startsWith(serverUrl) ? serverUrl : url.slice(0, url.lastIndexOf('/') + 1)
  const segments = url.slice(base.length).split('/').map((segment) => {
    try { return decodeURIComponent(segment) } catch { return segment }
  })
  return { serverUrl: base, directory: segments.slice(0, -1).join('/'), filename: segments.at(-1) || DEFAULT_WEBDAV_FILENAME }
}

export function buildWebDavLocation(location: WebDavLocation): { url: string; serverUrl: string } {
  let server: URL
  try { server = new URL(location.serverUrl.trim()) } catch { throw new Error('请填写有效的 WebDAV 服务器地址，例如 https://dav.example.com/dav/') }
  if (!['https:', 'http:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error('服务器地址须为 HTTP(S) 地址，不含账号、密码、查询参数或片段；账号密码请在独立字段填写')
  if (!server.pathname.endsWith('/')) server.pathname += '/'
  const directory = location.directory.trim().replace(/^\/+|\/+$/g, '')
  const filename = location.filename.trim() || DEFAULT_WEBDAV_FILENAME
  if (filename.includes('/')) throw new Error('备份文件名不能包含斜杠，请将目录填写在「备份目录」中')
  const segments = [...(directory ? directory.split('/') : []), filename]
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\\u0000-\u001f\u007f]/.test(segment))) throw new Error('备份目录和文件名不能包含空路径段、.、..、反斜杠或控制字符')
  const url = server.href + segments.map((segment) => encodeURIComponent(segment)).join('/')
  if (url.length > 4096) throw new Error('WebDAV 备份地址过长，请缩短目录或文件名')
  return { url, serverUrl: server.href }
}
