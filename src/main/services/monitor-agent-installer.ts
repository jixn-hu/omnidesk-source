import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper } from 'ssh2'
import type { MonitorInstallInput, MonitorInstallProgress, MonitorInstallResult, MonitorNode } from '@shared/monitoring'
import type { SessionInfo } from '@shared/types'
import type { ConnectionStore } from './connection-store'
import type { SshService } from './ssh'
import type { MonitoringService } from './monitoring'

const CONFIG = '/etc/omnidesk-monitor-agent/agent.json'
const STATE = '/var/lib/omnidesk-monitor-agent/state.json'
const PROBE = `set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(uname -s)" = Linux ] || exit 41
for tool in install sha256sum; do command -v "$tool" >/dev/null || exit 43; done
case "$(uname -m)" in x86_64|amd64) arch=amd64;; aarch64|arm64) arch=arm64;; *) exit 44;; esac
if [ "$(id -u)" = 0 ]; then privilege=root
elif command -v sudo >/dev/null && sudo -n -- sh -c 'test "$(id -u)" = 0' 2>/dev/null; then privilege=sudo
elif command -v sudo >/dev/null; then privilege=password
else privilege=user; fi
[ ! -e /etc/omnidesk-monitor/agent.json ] || exit 46
home=$(cd "$HOME" && pwd -P) || exit 47
systemd=0; [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null || ! command -v useradd >/dev/null || systemd=1
user_install=0; [ ! -e "$home/.local/share/omnidesk-monitor-agent" ] && [ ! -L "$home/.local/share/omnidesk-monitor-agent" ] || user_install=1
printf 'OMNIDESK_READY\n%s\n%s\n%s\n%s\n%s\n%s\n' "$arch" "$privilege" "$(hostname)" "$home" "$systemd" "$user_install"`
const READ_CONFIG = `set -eu
for path in /etc/omnidesk-monitor-agent /etc/omnidesk-monitor-agent/agent.json /usr/local/bin/omnidesk-monitor-agent /usr/local/bin/omnidesk-monitor-agent.new /etc/systemd/system/omnidesk-monitor-agent.service /var/lib/omnidesk-monitor-agent /var/lib/omnidesk-monitor-agent/state.json; do
  [ ! -L "$path" ] || exit 4
done
[ ! -e /etc/omnidesk-monitor/agent.json ] || exit 4
unit=/etc/systemd/system/omnidesk-monitor-agent.service
if [ -e "$unit" ]; then
  grep -qx '# Managed by OmniDesk SSH installer v1' "$unit" || exit 4
else
  [ ! -e /usr/local/bin/omnidesk-monitor-agent ] && [ ! -e /etc/omnidesk-monitor-agent/agent.json ] && [ ! -e /var/lib/omnidesk-monitor-agent/state.json ] || exit 4
  ! systemctl cat omnidesk-monitor-agent.service >/dev/null 2>&1 || exit 4
fi
config=/etc/omnidesk-monitor-agent/agent.json
if [ ! -e "$config" ]; then
  [ ! -e /var/lib/omnidesk-monitor-agent/state.json ] || exit 4
  exit 3
fi
[ -f "$config" ] && [ "$(wc -c < "$config")" -le 65536 ] || exit 4
cat "$config"`
const READ_USER_CONFIG = `set -eu
base="$HOME/.local/share/omnidesk-monitor-agent"
for path in "$HOME/.local" "$HOME/.local/share" "$base" "$base/agent.json" "$base/state.json" "$base/agent" "$base/agent.new" "$base/managed" "$base/run.sh" "$base/start.sh" "$base/mode" "$base/run.pid" "$base/agent.pid" "$base/run.lock" "$base/install.lock" "$base/agent.log" "$base/backups" "$HOME/.config" "$HOME/.config/systemd" "$HOME/.config/systemd/user" "$HOME/.config/systemd/user/omnidesk-monitor-agent.service"; do
  [ ! -L "$path" ] || exit 4
done
unit="$HOME/.config/systemd/user/omnidesk-monitor-agent.service"
if [ -e "$unit" ]; then grep -qx '# Managed by OmniDesk user installer v1' "$unit" || exit 4; fi
if [ ! -e "$base" ]; then [ ! -e "$unit" ] || exit 4; exit 3; fi
[ -f "$base/managed" ] && grep -qx '# Managed by OmniDesk user installer v1' "$base/managed" || exit 4
config="$base/agent.json"
[ -e "$config" ] || { [ ! -e "$base/state.json" ] && exit 3; exit 4; }
[ -f "$config" ] && [ -r "$config" ] && [ "$(wc -c < "$config")" -le 65536 ] || exit 4
cat "$config"`
const USER_CHECK = `set -eu
[ -d "$HOME" ] && [ -w "$HOME" ] || exit 47
for tool in flock nohup readlink; do command -v "$tool" >/dev/null || exit 48; done
for path in "$HOME/.local" "$HOME/.local/share" "$HOME/.config" "$HOME/.config/systemd" "$HOME/.config/systemd/user"; do
  if [ -e "$path" ]; then [ -d "$path" ] && [ -w "$path" ] || exit 47; fi
done`
class InstallError extends Error {}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export class MonitorAgentInstaller {
  private connectionsInUse = new Set<string>()
  private nodesInUse = new Set<string>()
  private preparingNodes = new Map<string, Promise<MonitorNode>>()
  constructor(private monitoring: MonitoringService, private connections: ConnectionStore, private ssh: SshService,
    private runtime: string, private progress: (value: MonitorInstallProgress) => void,
    private options: { reportTimeoutMs?: number; reportPollMs?: number } = {}) {}

  async sessionInfo(sessionId: string): Promise<import('@shared/monitoring').MonitorSessionInfo> {
    const config = this.monitoring.local().config
    if (!config.enabled || !config.url) return { linux: false }
    const revision = this.monitoring.agentInstallation('000000000000000000000000').revision
    const session = this.ssh.list().find(info => info.id === sessionId && info.status === 'connected')
    if (!session) throw new Error('SSH 会话未连接')
    const connection = this.ssh.getConnection(sessionId)
    const platform = await this.ssh.exec(sessionId, 'uname -s', { timeoutMs: 8000, maxBytes: 128 })
    if (platform.code !== 0 || platform.stdout.trim() !== 'Linux') return { linux: false }
    let nodeId = this.monitoring.agentNodeForConnection(connection.id)
    if (!nodeId) {
      // Recover association for collectors installed before local bindings were introduced.
      let previous = await this.ssh.exec(sessionId, 'sh -c ' + quote(READ_USER_CONFIG), { timeoutMs: 10000, maxBytes: 65537 }).catch(() => undefined)
      if (previous?.code === 3) previous = await this.ssh.exec(sessionId, 'sh -c ' + quote(READ_CONFIG) + ' || sudo -n -- sh -c ' + quote(READ_CONFIG), { timeoutMs: 10000, maxBytes: 65537 }).catch(() => undefined)
      if (previous?.code === 0 && !previous.truncated) {
        try { const saved = JSON.parse(previous.stdout); if (typeof saved.serverUrl === 'string' && saved.serverUrl.replace(/\/$/, '') === config.url.replace(/\/$/, '') && /^[a-f0-9]{24}$/.test(saved.nodeId)) nodeId = saved.nodeId } catch { /* No usable managed config. */ }
      }
    }
    this.monitoring.assertInstallRevision(revision)
    if (!nodeId) return { linux: true }
    const nodes = await this.monitoring.request<MonitorNode[]>('/v1/nodes').catch(() => undefined)
    this.monitoring.assertInstallRevision(revision)
    const node = nodes?.find(item => item.id === nodeId)
    if (nodes && !node) { this.monitoring.forgetAgentConnection(nodeId); return { linux: true } }
    this.monitoring.rememberAgentConnection(nodeId, connection.id)
    return { linux: true, nodeId, node }
  }
  prepareNode(connectionId: string): Promise<MonitorNode> {
    const revision = this.monitoring.agentInstallation('000000000000000000000000').revision
    const key = revision + ':' + connectionId + ':' + this.connections.get(connectionId)?.updatedAt
    const pending = this.preparingNodes.get(key)
    if (pending) return pending
    const operation = this.prepareTarget(connectionId)
    this.preparingNodes.set(key, operation)
    void operation.finally(() => this.preparingNodes.delete(key)).catch(() => {})
    return operation
  }
  private async prepareTarget(connectionId: string): Promise<MonitorNode> {
    const connection = this.connections.get(connectionId)
    if (!connection || connection.kind !== 'ssh') return this.monitoring.prepareAgentNode(connectionId)
    if (this.connectionsInUse.has(connectionId)) throw new InstallError('该服务器正在安装，请等待完成')
    const connectionRevision = connection.updatedAt
    const revision = this.monitoring.agentInstallation('000000000000000000000000').revision
    this.connectionsInUse.add(connectionId)
    const owner = 'monitor-prepare-' + randomUUID()
    let owned: string | undefined
    const track = (info: SessionInfo) => { if (info.ownerId === owner) owned = info.id }
    this.ssh.on('sessionEvent', track)
    try {
      const session = this.ssh.list().find(info => info.connectionId === connectionId && info.status === 'connected' && this.ssh.getConnection(info.id).updatedAt === connectionRevision)
        ?? await this.ssh.connect(connection, owner)
      await this.sessionInfo(session.id)
      this.monitoring.assertInstallRevision(revision)
      if (this.connections.get(connectionId)?.updatedAt !== connectionRevision) throw new InstallError('服务器连接配置已变化，请重新安装')
      return await this.monitoring.prepareAgentNode(connectionId)
    } catch (error) {
      if (error instanceof InstallError) throw error
      throw new InstallError('无法检查目标服务器，请检查 SSH 连接、监控账号与保险箱状态后重试')
    } finally {
      this.ssh.off('sessionEvent', track)
      if (owned) this.ssh.disconnect(owned)
      this.connectionsInUse.delete(connectionId)
    }
  }
  async removeNode(id: string): Promise<void> {
    if (this.nodesInUse.has(id)) throw new Error('节点正在安装采集端，请等待完成后再删除')
    this.nodesInUse.add(id)
    try { await this.monitoring.removeNode(id) } finally { this.nodesInUse.delete(id) }
  }
  async install(input: MonitorInstallInput): Promise<MonitorInstallResult> {
    if (!input || !/^[a-f0-9]{24}$/.test(input.nodeId) || typeof input.connectionId !== 'string' || input.renewToken !== undefined && typeof input.renewToken !== 'boolean') throw new InstallError('无效采集端安装参数')
    if (input.replaceBinding && (typeof input.replaceBinding !== 'object' || !/^[a-f0-9]{24}$/.test(input.replaceBinding.nodeId) || typeof input.replaceBinding.serverUrl !== 'string')) throw new InstallError('无效的覆盖确认，请重新检查目标服务器')
    if (input.installMode !== undefined && !['auto', 'user'].includes(input.installMode) || input.sudoPassword !== undefined && (typeof input.sudoPassword !== 'string' || input.sudoPassword.length > 4096 || /[\r\n\0]/.test(input.sudoPassword))) throw new InstallError('无效的安装方式或提权密码')
    const connection = this.connections.get(input.connectionId)
    if (!connection || connection.kind !== 'ssh') throw new InstallError('请选择已保存的 Linux SSH 连接')
    if (this.connectionsInUse.has(connection.id) || this.nodesInUse.has(input.nodeId)) throw new InstallError('该服务器或监控节点正在安装，请等待完成')
    const connectionRevision = connection.updatedAt
    const context = this.monitoring.agentInstallation(input.nodeId)
    if (!context.token && !input.renewToken) throw new InstallError('本机没有此节点的采集令牌，请确认更换令牌后安装')
    this.connectionsInUse.add(connection.id); this.nodesInUse.add(input.nodeId)
    let sessionId: string | undefined, owned = false, sftp: SFTPWrapper | undefined, stage: string | undefined
    let phase = '连接服务器', tokenRotated = false
    const owner = 'monitor-install-' + randomUUID()
    const track = (info: SessionInfo) => { if (info.ownerId === owner) { sessionId = info.id; owned = true } }
    const check = () => {
      try { this.monitoring.assertInstallRevision(context.revision) } catch { throw new InstallError('监控配置或保险箱状态已变化，请重新安装') }
      if (this.connections.get(connection.id)?.updatedAt !== connectionRevision) throw new InstallError('服务器连接配置已变化，请重新安装')
    }
    const emit = (value: MonitorInstallProgress['stage'], label: string) => { phase = label; this.progress({ nodeId: input.nodeId, connectionId: connection.id, stage: value }) }
    this.ssh.on('sessionEvent', track)
    try {
      const beforeNodes = await this.monitoring.request<MonitorNode[]>('/v1/nodes')
      const before = beforeNodes.find(node => node.id === input.nodeId)
      if (!before) throw new InstallError('监控节点不存在，请刷新列表')
      check(); emit('connecting', '连接服务器')
      const reusable = this.ssh.list().find(info => info.status === 'connected' && info.connectionId === connection.id && this.ssh.getConnection(info.id).updatedAt === connectionRevision)
      sessionId = reusable?.id
      if (!sessionId) { const session = await this.ssh.connect(connection, owner); sessionId = session.id; owned = true }
      check(); emit('checking', '检查安装环境')
      const probe = await this.ssh.exec(sessionId, PROBE, { timeoutMs: 15000, maxBytes: 4096 })
      const failures: Record<number, string> = { 41: '自动安装仅支持 Linux', 43: '目标缺少 install 或 sha256sum 命令', 44: '自动安装仅支持 Linux x64 和 ARM64', 46: '检测到旧版手动采集配置，已保留原安装，请先迁移或选择其他 VPS', 47: '当前 SSH 账号需要可写的主目录' }
      if (probe.code !== 0) throw new InstallError(failures[probe.code ?? 0] ?? '无法检查目标安装环境')
      const [marker, arch, privilege, hostname, home, systemd, userPresent] = probe.stdout.trimEnd().split(/\r?\n/)
      if (marker !== 'OMNIDESK_READY' || !['amd64','arm64'].includes(arch) || !['root','sudo','password','user'].includes(privilege) || !hostname || !home?.startsWith('/') || /[\r\n\0]/.test(home) || !['0','1'].includes(systemd) || !['0','1'].includes(userPresent)) throw new InstallError('服务器环境响应异常')
      // Reinstall in the existing user scope, even when sudo becomes available later.
      const userMode = input.installMode === 'user' || userPresent === '1' || systemd === '0' || privilege === 'user'
      const authorize = (message: string): MonitorInstallResult => ({ active: false, reported: false, needsSudoPassword: true, message })
      const elevated = (command: string, timeoutMs = 15000, maxBytes = 65537) => this.ssh.exec(sessionId!, (privilege === 'sudo' ? 'sudo -n -- ' : privilege === 'password' ? "sudo -S -k -p '' -- " : '') + command,
        { timeoutMs, maxBytes, ...(privilege === 'password' ? { stdin: input.sudoPassword + '\n' } : {}) })
      if (!userMode && privilege === 'password') {
        if (!input.sudoPassword) return authorize('此账号提权需要 sudo 密码。可输入密码安装系统服务，也可选择以当前用户安装。')
        const auth = await elevated('sh -c ' + quote('test "$(id -u)" = 0'), 15000, 1024)
        if (auth.code !== 0) return authorize('未能获得 sudo 权限。请检查密码及账号授权；也可选择以当前用户安装。')
      }
      const statePath = userMode ? home + '/.local/share/omnidesk-monitor-agent/state.json' : STATE
      if (userMode) {
        const checkUser = await this.ssh.exec(sessionId, USER_CHECK, { timeoutMs: 10000, maxBytes: 1024 })
        if (checkUser.code !== 0) throw new InstallError(checkUser.code === 48 ? '用户级安装需要 flock、nohup 和 readlink 命令' : '当前账号没有可用的用户安装目录')
        // Never start a second collector alongside an inaccessible system installation.
        const system = await this.ssh.exec(sessionId, 'test ! -e /etc/omnidesk-monitor-agent && sh -c ' + quote(READ_CONFIG), { timeoutMs: 10000, maxBytes: 65537 })
        if (system.code !== 3) throw new InstallError('已有系统级或手动采集端，请使用有提权权限的账号维护原安装，避免重复运行')
      } else {
        const tools = await elevated('sh -c ' + quote('command -v useradd >/dev/null'), 10000, 1024)
        if (tools.code !== 0) throw new InstallError('系统级安装缺少 useradd 或提权被拒绝；可尝试以当前用户安装')
      }
      const name = 'omnidesk-monitor-agent-linux-' + arch, scriptName = userMode ? 'install-user.sh' : 'install.sh'
      const manifest = JSON.parse(readFileSync(join(this.runtime, 'manifest.json'), 'utf8'))
      const binary = readFileSync(join(this.runtime, name)), script = readFileSync(join(this.runtime, scriptName))
      if (manifest.protocol !== 1 || binary.subarray(0, 4).toString('hex') !== '7f454c46' || binary.readUInt16LE(18) !== (arch === 'amd64' ? 62 : 183) || ([ [name, binary], [scriptName, script] ] as const).some(([file, bytes]) => createHash('sha256').update(bytes).digest('hex') !== manifest.files[file as string])) throw new InstallError('内置采集程序校验失败，请重新安装客户端')
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => this.ssh.getClient(sessionId!).sftp((error, channel) => error ? reject(error) : resolve(channel)))
      let existing: Record<string, unknown> | undefined
      const previous = userMode ? await this.ssh.exec(sessionId, 'sh -c ' + quote(READ_USER_CONFIG), { timeoutMs: 15000, maxBytes: 65537 }) : await elevated('sh -c ' + quote(READ_CONFIG))
      if (previous.truncated) throw new InstallError('已有采集配置过大，已保留原文件')
      if (previous.code === 0) {
        try { existing = JSON.parse(previous.stdout); if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error() }
        catch { throw new InstallError('已有采集配置无法安全读取，已停止安装并保留原文件') }
      } else if (previous.code !== 3) throw new InstallError('目标 VPS 已有手动安装、符号链接或不可读配置，已保留原安装')
      if (existing && (typeof existing.serverUrl !== 'string' || existing.statePath !== statePath || typeof existing.nodeId !== 'string' || !/^[a-f0-9]{24}$/.test(existing.nodeId))) throw new InstallError('目标 VPS 已有其他服务或自定义路径的采集配置，已保留原安装')
      if (existing) {
        try {
          const address = new URL(existing.serverUrl as string)
          if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error()
        } catch { throw new InstallError('已有上报地址无效，请检查目标服务器配置') }
      }
      const resetState = !!existing && (existing.nodeId !== input.nodeId || (existing.serverUrl as string).replace(/\/$/, '') !== context.url.replace(/\/$/, ''))
      if (resetState && (input.replaceBinding?.nodeId !== existing!.nodeId || input.replaceBinding?.serverUrl !== existing!.serverUrl)) {
        const oldName = existing!.serverUrl === context.url ? beforeNodes.find(node => node.id === existing!.nodeId)?.name : undefined
        return { active: false, reported: false, message: '此服务器已绑定其他监控节点。确认覆盖后将停止旧绑定的上报，旧历史保留在原节点；旧配置和状态会备份，新绑定重新统计流量。', replacement: { nodeId: existing!.nodeId as string, serverUrl: existing!.serverUrl as string, ...(oldName ? { nodeName: oldName } : {}) } }
      }
      check()
      // Mint a replacement only after the target passes checks; otherwise the current node stays untouched.
      let token = context.token
      if (input.renewToken) { token = (await this.monitoring.rotateAgentToken(input.nodeId)).token; tokenRotated = true }
      if (!token) throw new InstallError('未找到采集端令牌')
      const installationId = randomUUID().replace(/-/g, '')
      const config = Buffer.from(JSON.stringify({ installationId, nodeId: input.nodeId, serverUrl: context.url, token, statePath,
        intervalSeconds: (resetState ? before.intervalSeconds : existing?.intervalSeconds) ?? before.intervalSeconds ?? context.defaultIntervalSeconds ?? 60, includeNics: existing?.includeNics ?? [], allowInsecure: context.allowInsecure,
        ...(existing?.disableDiscovery !== undefined ? { disableDiscovery: existing.disableDiscovery } : {}) }, null, 2))
      check(); emit('uploading', '上传采集程序和配置')
      stage = '/tmp/omnidesk-monitor-install-' + randomUUID().replace(/-/g, '')
      const mkdir = await this.ssh.exec(sessionId, 'umask 077; mkdir -m 700 ' + quote(stage), { timeoutMs: 10000, maxBytes: 1024 })
      if (mkdir.code !== 0) { stage = undefined; throw new InstallError('无法创建私有安装目录') }
      for (const [file, bytes] of [['agent', binary], ['agent.json', config], ['install.sh', script]] as const) {
        check()
        await pipeline(Readable.from([bytes]), sftp.createWriteStream(stage + '/' + file, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(60000) })
      }
      check(); emit('installing', '安装并启动后台服务')
      const installCommand = 'sh ' + quote(stage + '/install.sh') + ' ' + quote(stage) + ' ' + quote(manifest.files[name]) + ' ' + (resetState ? '1' : '0')
      const result = userMode ? await this.ssh.exec(sessionId, installCommand, { timeoutMs: 90000, maxBytes: 2048 }) : await elevated(installCommand, 90000, 2048)
      if (result.code !== 0 || !result.stdout.includes('OMNIDESK_INSTALL_OK')) throw new InstallError(result.stdout.includes('OMNIDESK_INSTALL_ROLLED_BACK') ? '安装失败，已尝试恢复原程序和配置；备份保留在原安装目录的 backups 或 /var/backups/omnidesk-monitor-agent' : '安装未完成，已有手动安装、目录权限或服务限制可能阻止了部署')
      const startup = !userMode ? 'system' : result.stdout.includes('OMNIDESK_STARTUP=user-systemd') ? 'user-systemd' : result.stdout.includes('OMNIDESK_STARTUP=cron') ? 'cron' : 'none'
      const persistence = startup === 'system' ? '已设置系统服务开机自启。' : startup === 'user-systemd' ? '以当前用户运行，已确认 linger 并设置用户服务开机自启。' : startup === 'cron' ? '以当前用户后台运行，已写入 cron 开机启动项，依赖系统 cron 服务；若系统在退出登录时清理用户进程，需管理员启用 linger。' : '以当前用户后台运行；未找到可用的开机自启方式，重启或系统清理用户进程后需重新安装启动。'
      this.monitoring.rememberAgentConnection(input.nodeId, connection.id)
      emit('reporting', '等待采集端首次上报')
      const end = Date.now() + (this.options.reportTimeoutMs ?? 40000)
      do {
        check()
        try {
          const nodes = await this.monitoring.request<MonitorNode[]>('/v1/nodes')
          const node = nodes.find(item => item.id === input.nodeId)
          if (node && node.lastSeen > before.lastSeen && node.metrics?.installationId === installationId && node.metrics?.system.hostname === hostname) return { active: true, reported: true, message: (resetState ? '采集端已重新接入并成功上报。旧配置和采集状态已备份，原节点历史保留，新绑定从本次接入开始统计流量。' : '采集端已安装并成功上报。') + persistence }
        } catch { check() }
        await delay(this.options.reportPollMs ?? 2000)
      } while (Date.now() < end)
      const status = await this.ssh.exec(sessionId, userMode ? 'sh ' + quote(home + '/.local/share/omnidesk-monitor-agent/start.sh') + ' status' : 'systemctl is-active --quiet omnidesk-monitor-agent.service', { timeoutMs: 10000, maxBytes: 1024 })
      return { active: status.code === 0, reported: false, message: (status.code === 0 ? '采集端已安装并运行，暂未收到首次上报。请检查 VPS 到监控服务的网络和证书，稍后刷新监控。' : '采集端已安装，但服务未保持运行。请检查 VPS 的 omnidesk-monitor-agent 服务日志。') + persistence + (resetState ? ' 旧配置和采集状态已备份，原节点历史保留，新绑定重新统计流量。' : '') }
    } catch (error) {
      // Only controlled messages escape this service. SSH/SFTP output may contain secrets.
      const suffix = tokenRotated ? ' 此节点令牌已更换并保存在本机，请重试安装以写入新令牌。' : ''
      if (error instanceof InstallError) throw new InstallError(error.message + suffix)
      throw new InstallError(`${phase}失败，请检查 SSH 连接、目标权限与磁盘空间。` + suffix)
    } finally {
      if (stage && sessionId) {
        await this.ssh.exec(sessionId, 'rm -f ' + ['agent.json','agent','install.sh'].map(name => quote(stage + '/' + name)).join(' ') + '; rmdir ' + quote(stage), { timeoutMs: 10000, maxBytes: 1024 }).catch(() => {})
      }
      sftp?.end()
      this.ssh.off('sessionEvent', track)
      if (owned && sessionId) this.ssh.disconnect(sessionId)
      this.connectionsInUse.delete(connection.id); this.nodesInUse.delete(input.nodeId)
    }
  }
}
