/** Optional sections are allowlisted; connection records and their credentials are always included. */
export const BACKUP_SECTIONS = ['monitoring', 'preferences', 'aiSettings', 'aiHistory', 'serviceCredentials'] as const
export type BackupSection = typeof BACKUP_SECTIONS[number]
export interface BackupOptions { sections: BackupSection[]; preferences?: BackupPreferences }
export interface BackupPreferences { appearance: Record<string, string | number | boolean>; monitorView: 'cards' | 'list' }
export const BACKUP_LABELS: Record<BackupSection, string> = {
  monitoring: '监控配置与节点关联', preferences: '外观与终端偏好', aiSettings: 'AI 配置', aiHistory: 'AI 对话记录', serviceCredentials: '服务访问凭据'
}
export function backupOptions(input?: BackupOptions): BackupOptions {
  if (input === undefined) return { sections: [] }
  if (!input || !Array.isArray(input.sections) || input.sections.some(item => !BACKUP_SECTIONS.includes(item)) || new Set(input.sections).size !== input.sections.length) throw new Error('备份内容选择无效')
  return { sections: [...input.sections], ...(input.preferences ? { preferences: validateBackupPreferences(input.preferences) } : {}) }
}
export function validateBackupPreferences(input: unknown): BackupPreferences {
  const raw = input as BackupPreferences
  if (!raw || !raw.appearance || typeof raw.appearance !== 'object' || Array.isArray(raw.appearance) || !['cards', 'list'].includes(raw.monitorView)) throw new Error('界面偏好格式不正确')
  const enums: Record<string, readonly (string | number)[]> = {
    theme: ['system', 'light', 'dark'], uiFont: ['system', 'yahei', 'pingfang', 'noto'], uiScale: [90, 100, 110, 125],
    terminalFont: ['cascadia', 'consolas', 'jetbrains', 'dejavu'], terminalTheme: ['dark', 'light', 'follow'], sidebarLayout: ['tree', 'grouped', 'flat', 'tags', 'accounts']
  }
  const appearance: BackupPreferences['appearance'] = {}
  for (const [key, value] of Object.entries(raw.appearance)) {
    if (Object.hasOwn(enums, key) && enums[key].includes(value as string | number)) appearance[key] = value
    else if (['sidebarShowAddress', 'sidebarShowUsername', 'sidebarShowTags', 'sidebarShowNote'].includes(key) && typeof value === 'boolean') appearance[key] = value
    else if (key === 'terminalFontSize' && typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 24) appearance[key] = value
    else throw new Error('界面偏好包含无效项目')
  }
  return { appearance, monitorView: raw.monitorView }
}
