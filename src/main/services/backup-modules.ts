import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateBackupPreferences, type BackupPreferences } from '@shared/backup.js'
import type { Credential } from '@shared/types.js'
import type { BackupModules } from './config-backup.js'
import type { MonitoringService } from './monitoring.js'
import type { AiService } from './ai.js'
import type { VaultService } from './vault.js'

const AI = 'omnidesk-ai-api-key'
function credential(input: any, max: number, allowSpaces = false): Credential {
  if (!input || typeof input.secret !== 'string' || !input.secret || input.secret.length > max || (allowSpaces ? /[\0\r\n]/ : /\s/).test(input.secret) || Object.keys(input).some(key => key !== 'secret')) throw new Error('服务凭据备份格式不正确')
  return { secret: input.secret }
}
export function createBackupModules(directory: string, monitoring: MonitoringService, ai: AiService, vault: VaultService): BackupModules {
  return {
    capture(options) {
      const modules: ReturnType<BackupModules['capture']> = {}
      for (const section of options.sections) {
        if (section === 'monitoring') modules.monitoring = monitoring.backupConfiguration()
        if (section === 'aiSettings') { const { hasApiKey, ...settings } = ai.configuration(); modules.aiSettings = settings }
        if (section === 'aiHistory') modules.aiHistory = ai.backupHistory()
        if (section === 'preferences') {
          const path = join(directory, 'backup-preferences.json')
          const preferences = options.preferences ?? (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined)
          if (!preferences) throw new Error('请从备份页面读取界面偏好后重试')
          modules.preferences = validateBackupPreferences(preferences)
        }
        if (section === 'serviceCredentials') {
          const { url, key: scopeKey, prefix } = monitoring.backupScope(), baseUrl = ai.configuration().baseUrl
          const key = vault.getCredential(AI)
          const agents = Object.fromEntries(vault.listCredentialRefs().filter(ref => ref.startsWith(prefix)).map(ref => [ref.slice(prefix.length), { secret: vault.getCredential(ref)!.secret }]))
          modules.serviceCredentials = { ...(url ? { monitor: { url, scopeKey, agents } } : {}), ...(baseUrl && key ? { ai: { baseUrl, key: { secret: key.secret } } } : {}) }
        }
      }
      return modules
    },
    prepare(modules, ids) {
      const files: Record<string, string> = {}, credentials: Record<string, Credential> = {}, removeRefs: string[] = []
      const details: string[] = []
      let preferences: BackupPreferences | undefined
      const serviceCredentials = modules.serviceCredentials as any
      const needsMonitor = modules.monitoring !== undefined || serviceCredentials?.monitor !== undefined
      const needsAI = modules.aiSettings !== undefined || modules.aiHistory !== undefined || serviceCredentials?.ai !== undefined
      const previousMonitorURL = needsMonitor ? monitoring.local().config.url : ''
      const monitor = modules.monitoring !== undefined ? monitoring.prepareBackup(modules.monitoring, ids) : undefined
      const previousAIURL = needsAI ? ai.configuration().baseUrl : ''
      const aiData = needsAI ? ai.prepareBackup(modules.aiSettings, modules.aiHistory, ids) : undefined
      if (monitor) {
        files['monitoring.json'] = monitor.contents
        const saved = modules.monitoring as any
        details.push(`监控地址：${monitor.url || '未配置'}；备份中 ${saved.entries.length} 条节点关联，匹配本机连接后恢复。`)
      }
      if (modules.aiSettings !== undefined) details.push(`AI 配置：${(modules.aiSettings as any).model || '未配置模型'}（不含密钥）。`)
      if (modules.aiHistory !== undefined) details.push(`AI 对话记录：${(modules.aiHistory as any).items.length} 个对话；同 ID 更新，待确认操作停止。`)
      if (aiData) {
        Object.assign(files, aiData.files)
        if (aiData.baseUrl !== previousAIURL) removeRefs.push(AI)
      }
      if (modules.preferences !== undefined) {
        preferences = validateBackupPreferences(modules.preferences)
        files['backup-preferences.json'] = JSON.stringify(preferences)
      }
      if (modules.serviceCredentials !== undefined) {
        const data = modules.serviceCredentials as any
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['monitor', 'ai'].includes(key))) throw new Error('服务凭据备份格式不正确')
        if (data.monitor !== undefined) {
          const saved = data.monitor
          if (typeof saved?.url !== 'string' || saved.url !== (monitor?.url ?? previousMonitorURL) || !saved.scopeKey || saved.scopeKey !== monitoring.backupScope().key || Object.hasOwn(saved, 'token')) throw new Error('监控令牌对应的服务地址不一致，请同时选择正确的监控配置')
          if (!saved.agents || typeof saved.agents !== 'object' || Array.isArray(saved.agents) || Object.keys(saved.agents).length > 10000) throw new Error('采集端令牌格式不正确')
          for (const [id, value] of Object.entries(saved.agents)) {
            if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('采集端标识不正确')
            credentials[monitoring.backupScope().prefix + id] = credential(value, 512)
          }
        }
        if (data.ai !== undefined) {
          if (typeof data.ai?.baseUrl !== 'string' || data.ai.baseUrl !== (aiData?.baseUrl ?? previousAIURL)) throw new Error('AI 密钥对应的接口地址不一致，请同时选择正确的 AI 配置')
          credentials[AI] = credential(data.ai.key, 8192, true)
        }
      }
      if (modules.serviceCredentials !== undefined) details.push(`恢复 ${Object.keys(credentials).length} 个服务访问凭据，账号登录态与 WebDAV 密码不迁移。`)
      return { files, credentials, details, removeRefs: removeRefs.filter(ref => !Object.hasOwn(credentials, ref)), preferences, commit: () => { monitor?.commit(); aiData?.commit() } }
    }
  }
}
