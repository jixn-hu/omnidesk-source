import type { RdpOptions } from './types'

export interface SharedConnectionConfiguration {
  kind: 'ssh' | 'rdp'
  name: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  domain?: string
  note?: string
  group?: string
  tags?: string[]
  color?: string
  options?: RdpOptions
}

export function sharedConfiguration(input: unknown): SharedConnectionConfiguration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('共享连接配置格式不正确')
  const value = input as Record<string, unknown>
  const text = (name: string, maximum: number, required = false): string | undefined => {
    const entry = value[name]
    if (entry === undefined && !required) return undefined
    if (typeof entry !== 'string' || entry.length > maximum || entry.includes('\0') || (name !== 'note' && /[\r\n]/.test(entry)) || (required && !entry.trim())) throw new Error('共享连接字段格式不正确：' + name)
    return entry
  }
  if (!['ssh', 'rdp'].includes(value.kind as string) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new Error('共享协议或端口格式不正确')
  const authMethod = value.kind === 'rdp' ? 'password' : value.authMethod
  if (!['password', 'privateKey'].includes(authMethod as string)) throw new Error('配置共享需要已保存的密码或私钥，不支持 SSH Agent')
  const result: SharedConnectionConfiguration = { kind: value.kind as 'ssh' | 'rdp', name: text('name', 256, true)!, host: text('host', 1024, true)!, port: Number(value.port), username: text('username', 256, true)!, authMethod: authMethod as 'password' | 'privateKey', domain: text('domain', 256), note: text('note', 16384), group: text('group', 256), color: text('color', 128) }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 100 || value.tags.some(tag => typeof tag !== 'string' || tag.length > 128 || /[\0\r\n]/.test(tag))) throw new Error('共享标签格式不正确')
    result.tags = [...value.tags] as string[]
  }
  if (result.kind === 'rdp') {
    const options = value.options ?? { ignoreCertificate: value.ignoreCertificate !== false }
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('共享 RDP 选项格式不正确')
    const raw = options as Record<string, unknown>
    result.options = { ignoreCertificate: true }
    if (raw.engine !== undefined) {
      if (!['ironrdp', 'freerdp'].includes(raw.engine as string)) throw new Error('共享 RDP 引擎不正确')
      result.options.engine = raw.engine as RdpOptions['engine']
    }
    if (raw.securityMode !== undefined) {
      if (!['auto', 'legacy'].includes(raw.securityMode as string)) throw new Error('共享 RDP 安全模式不正确')
      result.options.securityMode = raw.securityMode as RdpOptions['securityMode']
    }
    if (raw.performanceMode !== undefined) {
      if (!['smooth', 'balanced', 'clear'].includes(raw.performanceMode as string)) throw new Error('共享 RDP 画质模式不正确')
      result.options.performanceMode = raw.performanceMode as RdpOptions['performanceMode']
    }
    for (const name of ['dynamicResolution', 'fullscreen', 'systemSmartSizing', 'enableClipboard', 'showWallpaper', 'fontSmoothing', 'desktopComposition', 'showDraggedWindow', 'showMenuAnimations', 'showThemes', 'showBlinkingCursor', 'ignoreCertificate'] as const) {
      if (raw[name] !== undefined) {
        if (typeof raw[name] !== 'boolean') throw new Error('共享 RDP 开关格式不正确')
        result.options[name] = raw[name]
      }
    }
    if (raw.audioCaptureMode !== undefined) {
      if (!['none', 'local', 'remote'].includes(raw.audioCaptureMode as string)) throw new Error('共享音频选项格式不正确')
      result.options.audioCaptureMode = raw.audioCaptureMode as RdpOptions['audioCaptureMode']
    }
    if (raw.colorDepth !== undefined) {
      if (![16, 24, 32].includes(raw.colorDepth as number)) throw new Error('共享色深选项格式不正确')
      result.options.colorDepth = raw.colorDepth as RdpOptions['colorDepth']
    }
  }
  return result
}
