import type { ExecResult } from '@shared/types.js'
import type { DockerContainer, DockerImage, DockerRemoveRequest, DockerSnapshot, DockerUnavailableReason } from '@shared/docker.js'
import type { SshService } from './ssh.js'

const INFO_FORMAT = '{"id":{{json .ID}},"version":{{json .ServerVersion}}}'
const INFO = '__OMNIDESK_DOCKER_INFO__'
const CONTAINERS = '__OMNIDESK_DOCKER_CONTAINERS__'
const IMAGES = '__OMNIDESK_DOCKER_IMAGES__'
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"

// Respect rootless/local contexts, but never let this server's sidebar manage a remote daemon.
const SETUP = [
  'export LC_ALL=C',
  '[ "$(uname -s)" = Linux ] || exit 40',
  'command -v docker >/dev/null 2>&1 || exit 41',
  'if [ -n "${DOCKER_CONTEXT:-}" ]; then',
  '  omni_endpoint=$(docker context inspect --format \'{{.Endpoints.docker.Host}}\' "$DOCKER_CONTEXT") || exit 42',
  'elif [ -n "${DOCKER_HOST:-}" ]; then',
  '  omni_endpoint=$DOCKER_HOST',
  'else',
  '  omni_endpoint=$(docker context inspect --format \'{{.Endpoints.docker.Host}}\') || exit 42',
  'fi',
  'case "$omni_endpoint" in unix:///*) ;; *) exit 43 ;; esac',
  'odocker() ( unset DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH; docker --host "$omni_endpoint" "$@" )',
  'omni_info=$(odocker info --format ' + quote(INFO_FORMAT) + ') || exit 44'
].join('\n')

function unavailable(result: ExecResult): { reason: DockerUnavailableReason; message: string } | undefined {
  switch (result.code) {
    case 40: return { reason: 'not-linux', message: '此面板支持 Linux 服务器。' }
    case 41: return { reason: 'not-installed', message: '服务器未安装 Docker，或当前 SSH 环境找不到 docker 命令。' }
    case 42: return { reason: 'context', message: '无法读取 Docker context，请在终端检查 docker context ls。' }
    case 43: return { reason: 'remote-context', message: '当前 Docker context 指向远程服务。此面板仅管理当前服务器的本地 Docker，请先在终端切换本地 context。' }
    case 44:
      return /permission denied|access denied|operation not permitted/i.test(result.stderr)
        ? { reason: 'permission', message: '当前 SSH 账号没有访问 Docker 的权限。请使用已有 Docker 权限的账号连接；面板不会自动提权。' }
        : { reason: 'daemon', message: 'Docker 服务不可达，请在终端确认服务已启动及本地 socket 配置正确。' }
    default: return undefined
  }
}
function checked(result: ExecResult): void {
  if (result.truncated) throw new Error('Docker 输出超过读取上限，未展示不完整结果。请在终端缩小查询范围。')
  if (result.code !== 0) {
    const known = unavailable(result)
    if (known) throw new Error(known.message)
    if (result.code === 45) throw new Error('Docker context 或服务已变化，请刷新列表后重新确认删除。')
    const detail = result.stderr.trim().slice(0, 1200)
    throw new Error('Docker 操作失败' + (detail ? '：' + detail : '，请刷新后重试。'))
  }
}
function rows(value: string): Record<string, unknown>[] {
  return value.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const row: unknown = JSON.parse(line)
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid Docker row')
    return row as Record<string, unknown>
  })
}
const text = (row: Record<string, unknown>, key: string) => typeof row[key] === 'string' ? row[key] as string : ''
const containerId = (id: string) => /^[a-f0-9]{64}$/.test(id)
const imageId = (id: string) => /^sha256:[a-f0-9]{64}$/.test(id)

export class DockerService {
  private removing = new Set<string>()
  constructor(private ssh: Pick<SshService, 'exec'>) {}

  async snapshot(sessionId: string): Promise<DockerSnapshot> {
    const result = await this.ssh.exec(sessionId, SETUP + '\n' + [
      'printf \'%s\n\' ' + quote(INFO) + ' "$omni_endpoint" "$omni_info"',
      'printf \'%s\n\' ' + quote(CONTAINERS),
      'odocker container ls --all --no-trunc --format \'{{json .}}\' || exit 46',
      'printf \'%s\n\' ' + quote(IMAGES),
      'odocker image ls --no-trunc --format \'{{json .}}\' || exit 46'
    ].join('\n'), { timeoutMs: 20000, maxBytes: 4 * 1024 * 1024 })
    const failure = unavailable(result)
    if (failure && !result.truncated) return { available: false, ...failure, containers: [], images: [], collectedAt: Date.now() }
    checked(result)
    try {
      const lines = result.stdout.replace(/\r/g, '').split('\n')
      const start = lines.indexOf(INFO), middle = lines.indexOf(CONTAINERS, start + 1), end = lines.indexOf(IMAGES, middle + 1)
      if (start < 0 || middle !== start + 3 || end <= middle) throw new Error('Missing sections')
      const endpoint = lines[start + 1], info = JSON.parse(lines[start + 2])
      if (!endpoint.startsWith('unix:///') || typeof info.id !== 'string' || !info.id || typeof info.version !== 'string') throw new Error('Invalid daemon')
      const containers: DockerContainer[] = rows(lines.slice(middle + 1, end).join('\n')).map(row => {
        const id = text(row, 'ID')
        if (!containerId(id)) throw new Error('Invalid container ID')
        return { id, name: text(row, 'Names'), image: text(row, 'Image'), state: text(row, 'State'), status: text(row, 'Status'), ports: text(row, 'Ports'), created: text(row, 'CreatedAt') }
      })
      const grouped = new Map<string, DockerImage>()
      for (const row of rows(lines.slice(end + 1).join('\n'))) {
        const id = text(row, 'ID')
        if (!imageId(id)) throw new Error('Invalid image ID')
        const image = grouped.get(id) ?? { id, tags: [], size: text(row, 'Size'), created: text(row, 'CreatedAt') }
        const repository = text(row, 'Repository'), tag = text(row, 'Tag')
        if (repository && repository !== '<none>') {
          const name = tag && tag !== '<none>' ? repository + ':' + tag : repository
          if (!image.tags.includes(name)) image.tags.push(name)
        }
        grouped.set(id, image)
      }
      return { available: true, endpoint, daemonId: info.id, version: info.version, containers, images: [...grouped.values()], collectedAt: Date.now() }
    } catch {
      throw new Error('无法解析 Docker 列表，请确认服务器 Docker 版本支持 JSON 格式输出。')
    }
  }

  async remove(sessionId: string, request: DockerRemoveRequest): Promise<boolean> {
    if (!request || !['container', 'image'].includes(request.kind) || typeof request.id !== 'string' ||
        !(request.kind === 'container' ? containerId(request.id) : imageId(request.id)) ||
        typeof request.endpoint !== 'string' || !/^unix:\/\/\/[^\r\n]{1,1024}$/.test(request.endpoint) ||
        typeof request.daemonId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(request.daemonId)) {
      throw new Error('删除目标无效，请刷新 Docker 列表。')
    }
    const key = sessionId + ':' + request.kind + ':' + request.id
    if (this.removing.has(key)) throw new Error('该资源正在删除，请勿重复提交。')
    this.removing.add(key)
    try {
      const result = await this.ssh.exec(sessionId, SETUP + '\n' + [
        '[ "$omni_endpoint" = ' + quote(request.endpoint) + ' ] || exit 45',
        'omni_id=$(odocker info --format \'{{.ID}}\') || exit 44',
        '[ "$omni_id" = ' + quote(request.daemonId) + ' ] || exit 45',
        // No force, stop, volume removal, or prune. Docker enforces current resource state.
        'odocker ' + request.kind + ' rm -- ' + quote(request.id)
      ].join('\n'), { timeoutMs: 30000, maxBytes: 64 * 1024 })
      checked(result)
      return true
    } finally { this.removing.delete(key) }
  }
}
