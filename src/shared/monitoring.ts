import type { IpcResult, ServerMetrics } from './types'

export interface MonitorDiscovery {
  ip: string; provider: string; region: string; country: string; city: string
  timezone: string; asn: string; source: 'ipwho.is'; detectedAt: number
}
// Manual values always win; discovery never changes billing or renewal settings.
export function effectiveMonitorAsset(asset: MonitorAsset, discovered?: MonitorDiscovery): MonitorAsset {
  return { ...asset, provider: asset.provider || discovered?.provider || '', region: asset.region || discovered?.region || '' }
}
export interface MonitorAsset {
  provider: string
  region: string
  expiresAt: string
  price: number
  currency: string
  billingCycle: string
  vendorUrl: string
  autoPay: boolean
  trafficLimit: number
  trafficMode: 'sum' | 'up' | 'down' | 'max' | 'min'
  resetDay: number
  timezone: string
  initialUpload: number
  initialDownload: number
  initialPeriod: string
}
export const EMPTY_ASSET: MonitorAsset = { provider: '', region: '', expiresAt: '', price: 0, currency: 'CNY', billingCycle: 'monthly', vendorUrl: '', autoPay: false, trafficLimit: 0, trafficMode: 'sum', resetDay: 1, timezone: 'Asia/Shanghai', initialUpload: 0, initialDownload: 0, initialPeriod: '' }
export interface MonitorConfig { enabled: boolean; url: string; allowInsecure: boolean; hasToken: boolean; mode?: 'account'; scopeKey?: string; defaultIntervalSeconds?: number }
export interface MonitorEntry { connectionId: string; source: 'ssh' | 'agent'; nodeId?: string; asset: MonitorAsset; discovered?: MonitorDiscovery; discoveredHost?: string }
export interface MonitorLocal { config: MonitorConfig; entries: MonitorEntry[] }
export interface MonitorNode {
  id: string; name: string; group: string; asset: MonitorAsset; lastSeen: number; metrics?: ServerMetrics
  probeRequestId?:string; intervalSeconds?: number; todayUpload?: number; todayDownload?: number
  upload: number; download: number; periodUpload: number; periodDownload: number
  periodStart: number; periodEnd: number; coverageStart: number; incomplete: boolean
}
export interface MonitorPoint { timestamp: number; metrics: ServerMetrics; upload: number; download: number; incomplete: boolean }
export interface MonitorAlert { id: number; nodeId: string; kind: string; message: string; timestamp: number; delivered: boolean }
export type MonitorInstallStage = 'connecting' | 'checking' | 'uploading' | 'installing' | 'reporting'
export interface MonitorInstallProgress { nodeId: string; connectionId: string; stage: MonitorInstallStage }
export interface MonitorAgentBinding { nodeId: string; serverUrl: string; nodeName?: string }
export interface MonitorInstallInput { nodeId: string; connectionId: string; renewToken?: boolean; replaceBinding?: MonitorAgentBinding; installMode?: 'auto' | 'user'; sudoPassword?: string }
export interface MonitorWindowsCommand { command: string; expiresAt: number; installationId: string; serverUrl: string }
export interface MonitorInstallResult { active: boolean; reported: boolean; message: string; replacement?: MonitorAgentBinding; needsSudoPassword?: boolean }
export interface MonitorSessionInfo { linux: boolean; nodeId?: string; node?: MonitorNode }
export interface MonitoringApi {
  local: () => Promise<IpcResult<MonitorLocal>>
  configure: (input: { enabled: boolean; mode?: 'account'; defaultIntervalSeconds?: number }) => Promise<IpcResult<MonitorLocal>>
  saveEntry: (entry: MonitorEntry) => Promise<IpcResult<MonitorLocal>>
  removeEntry: (id: string) => Promise<IpcResult<MonitorLocal>>
  localHistory: (connectionId: string) => Promise<IpcResult<ServerMetrics[]>>
  requestProbe:(id:string)=>Promise<IpcResult<{requestId:string}>>
  unclaimed: () => Promise<IpcResult<MonitorNode[]>>
  claim: (id:string) => Promise<IpcResult<{ok:boolean}>>
  nodes: () => Promise<IpcResult<MonitorNode[]>>
  test: () => Promise<IpcResult<{ service: string; protocol: number }>>
  saveNode: (input: { id?: string; name: string; group: string; asset: MonitorAsset; intervalSeconds?: number }) => Promise<IpcResult<{ node?: MonitorNode; token?: string; ok?: boolean }>>
  prepareAgentNode: (connectionId: string) => Promise<IpcResult<MonitorNode>>
  removeNode: (nodeId: string) => Promise<IpcResult<void>>
  sessionInfo: (sessionId: string) => Promise<IpcResult<MonitorSessionInfo>>
  rotateToken: (id: string) => Promise<IpcResult<{ token: string }>>
  history: (id: string, hours: number) => Promise<IpcResult<MonitorPoint[]>>
  alerts: () => Promise<IpcResult<MonitorAlert[]>>
  agentInstallInfo: (nodeId: string) => Promise<IpcResult<{ hasToken: boolean; connectionId?: string }>>
  windowsInstallCommand: (input: MonitorInstallInput) => Promise<IpcResult<MonitorWindowsCommand>>
  exportWindowsInstaller: (input:MonitorInstallInput)=>Promise<IpcResult<{cancelled:boolean;path?:string;installationId?:string}>>
  installAgent: (input: MonitorInstallInput) => Promise<IpcResult<MonitorInstallResult>>
  onAgentInstallProgress: (callback: (progress: MonitorInstallProgress) => void) => () => void
}
export function trafficUsed(asset: MonitorAsset, up: number, down: number): number {
  switch (asset.trafficMode) { case 'up': return up; case 'down': return down; case 'max': return Math.max(up, down); case 'min': return Math.min(up, down); default: return up + down }
}
export function daysUntil(date: string, timezone = 'Asia/Shanghai'): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (key: string) => parts.find(item => item.type === key)?.value
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`)) / 86400000)
}
// Calendar renewal: clamp month-end dates rather than rolling into the next month.
export function renewedDate(date: string, cycle: string): string {
  const input = new Date(date + 'T00:00:00Z'); if (!Number.isFinite(input.getTime())) throw new Error('请先填写有效到期日期')
  const months = ({ monthly: 1, quarterly: 3, yearly: 12 } as Record<string, number>)[cycle]
  if (!months) throw new Error('自定义周期请直接编辑到期日期')
  const result = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth() + months, 1))
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()
  result.setUTCDate(Math.min(input.getUTCDate(), last)); return result.toISOString().slice(0, 10)
}
