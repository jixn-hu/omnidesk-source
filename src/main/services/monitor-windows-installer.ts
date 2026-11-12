import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MonitoringService } from './monitoring'
import type { ConnectionStore } from './connection-store'
import type { MonitorInstallInput, MonitorNode, MonitorWindowsCommand } from '@shared/monitoring'

async function windowsInstallation(monitoring: MonitoringService, connections: ConnectionStore, input: MonitorInstallInput) {
  if (!input || !/^[a-f0-9]{24}$/.test(input.nodeId) || typeof input.connectionId !== 'string' || input.renewToken !== undefined && typeof input.renewToken !== 'boolean') throw new Error('无效安装参数')
  const connection = connections.get(input.connectionId)
  if (!connection || connection.kind !== 'rdp') throw new Error('请选择 Windows RDP 连接')
  const context = monitoring.agentInstallation(input.nodeId)
  if (!context.token && !input.renewToken) throw new Error('缺少节点令牌，请先明确同意更换令牌')
  const nodes = await monitoring.request<MonitorNode[]>('/v1/nodes')
  const node = nodes.find(item => item.id === input.nodeId)
  if (!node) throw new Error('节点不存在')
  monitoring.assertInstallRevision(context.revision)
  const token = input.renewToken ? (await monitoring.rotateAgentToken(input.nodeId)).token : context.token!
  monitoring.assertInstallRevision(context.revision)
  if (connections.get(connection.id)?.updatedAt !== connection.updatedAt) throw new Error('目标连接已修改，请重新安装')
  monitoring.rememberAgentConnection(input.nodeId, connection.id)
  const config = { managedBy: 'omnidesk-monitor-windows-v1', nodeId: input.nodeId, serverUrl: context.url, token, statePath: '', intervalSeconds: node.intervalSeconds || context.defaultIntervalSeconds, includeNics: [], allowInsecure: context.allowInsecure, installationId: randomUUID().replace(/-/g, '') }
  return { config, context }
}

export async function windowsMonitorBundle(monitoring: MonitoringService, connections: ConnectionStore, runtime: string, input: MonitorInstallInput): Promise<{ contents: string; installationId: string }> {
  const manifest = JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8'))
  const binary = readFileSync(join(runtime, 'omnidesk-monitor-agent-windows-amd64.exe'))
  const template = readFileSync(join(runtime, 'install-windows.ps1'), 'utf8')
  const sha256 = createHash('sha256').update(binary).digest('hex')
  if (manifest.protocol !== 1 || manifest.files['omnidesk-monitor-agent-windows-amd64.exe'] !== sha256 || manifest.files['install-windows.ps1'] !== createHash('sha256').update(template).digest('hex') || binary.subarray(0, 2).toString() !== 'MZ') throw new Error('Windows 采集程序校验失败，请重新构建客户端')
  const { config } = await windowsInstallation(monitoring, connections, input)
  const bundle = Buffer.from(JSON.stringify({ config, sha256, binary: binary.toString('base64') })).toString('base64')
  return { contents: template.replace('__OMNIDESK_BUNDLE__', bundle), installationId: config.installationId }
}

const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'"
export async function windowsMonitorCommand(monitoring: MonitoringService, connections: ConnectionStore, input: MonitorInstallInput): Promise<MonitorWindowsCommand> {
  const { config, context } = await windowsInstallation(monitoring, connections, input)
  const result = await monitoring.request<{ downloadPath: string; ticket: string; sha256: string; expiresAt: number; installationId: string }>('/v1/install/windows', 'POST', { nodeId: input.nodeId, token: config.token, serverUrl: config.serverUrl, intervalSeconds: config.intervalSeconds })
  monitoring.assertInstallRevision(context.revision)
  if (result.downloadPath !== '/v1/monitor/install/windows/download' || !/^[A-Za-z0-9_-]{43}$/.test(result.ticket) || !/^[a-f0-9]{64}$/.test(result.sha256) || !/^[a-f0-9]{32}$/.test(result.installationId) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error('服务端返回了无效安装命令，请更新服务端或导出安装脚本')
  const address = context.url + '/install/windows/download'
  const command = `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $p=Join-Path $env:TEMP ([guid]::NewGuid().ToString()+'.ps1'); try { Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri ${quote(address)} -Headers @{'X-OmniDesk-Install'=${quote(result.ticket)}} -OutFile $p; if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne ${quote(result.sha256)}) { throw 'Installer integrity check failed' }; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p; if ($LASTEXITCODE -ne 0) { throw 'Installation failed' } } finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }`
  return { command, expiresAt: result.expiresAt, installationId: result.installationId, serverUrl: context.url }
}
