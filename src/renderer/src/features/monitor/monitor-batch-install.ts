import type { MonitoringApi, MonitorNode, MonitorWindowsCommand } from '@shared/monitoring'
import type { Connection, IpcResult } from '@shared/types'

export type BatchInstallStatus = 'queued' | 'preparing' | 'installing' | 'reported' | 'started' | 'command' | 'attention' | 'failed' | 'cancelled'
export interface BatchInstallRow {
  target: Connection
  status: BatchInstallStatus
  message: string
  node?: MonitorNode
  command?: MonitorWindowsCommand
  watchUntil?: number
}
export interface BatchInstallOptions {
  api: MonitoringApi
  installMode: 'auto' | 'user'
  isCurrent: () => boolean
  shouldStart: () => boolean
  update: (connectionId: string, update: Partial<BatchInstallRow>) => void
}

// Stop only the queue. An installation already running is allowed to finish.
export async function runMonitorBatch(targets: Connection[], options: BatchInstallOptions): Promise<void> {
  const { api, isCurrent, shouldStart, update } = options
  const request = async <T>(operation: () => Promise<IpcResult<T>>): Promise<T> => {
    if (!isCurrent()) throw new Error('账号或安装窗口已变化')
    const result = await operation()
    if (!isCurrent()) throw new Error('账号或安装窗口已变化')
    if (!result.ok) throw new Error(result.message)
    return result.data
  }
  const patch = (id: string, value: Partial<BatchInstallRow>) => { if (isCurrent()) update(id, value) }
  const pending = [...new Map(targets.map(target => [target.id, target])).values()]
  if (!pending.length || !isCurrent()) return
  try {
    const local = await request(() => api.local())
    if (!local.config.enabled) await request(() => api.configure({ enabled: true }))
  } catch (error) {
    for (const target of pending) patch(target.id, { status: 'failed', message: error instanceof Error ? error.message : '无法启用监控' })
    return
  }
  let next = 0
  const worker = async () => {
    while (isCurrent() && shouldStart() && next < pending.length) {
      const target = pending[next++]!
      patch(target.id, { status: 'preparing', message: '正在检查连接与已有监控绑定…', command: undefined, watchUntil: undefined })
      try {
        const node = await request(() => api.prepareAgentNode(target.id))
        patch(target.id, { node })
        const info = await request(() => api.agentInstallInfo(node.id))
        if (!info.hasToken) {
          patch(target.id, { status: 'attention', message: '本机未保存采集令牌，请单独处理并确认是否更换令牌。' })
          continue
        }
        const input = { nodeId: node.id, connectionId: target.id }
        if (target.kind === 'rdp') {
          const command = await request(() => api.windowsInstallCommand(input))
          patch(target.id, { status: 'command', command, watchUntil: Date.now() + 20 * 60 * 1000, message: '请在此 Windows 的管理员 PowerShell 执行对应命令，等待本次安装上报。' })
        } else {
          patch(target.id, { status: 'installing', message: '正在安装采集端…' })
          const result = await request(() => api.installAgent({ ...input, installMode: options.installMode }))
          patch(target.id, { status: result.reported ? 'reported' : result.active ? 'started' : 'attention', message: result.message })
        }
      } catch (error) {
        patch(target.id, { status: 'failed', message: error instanceof Error ? error.message : '安装失败，请重试' })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker))
  for (const target of pending.slice(next)) patch(target.id, { status: 'cancelled', message: '已停止排队，此服务器尚未开始。' })
}
