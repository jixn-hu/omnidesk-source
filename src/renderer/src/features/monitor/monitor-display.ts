import { mostUsedDisk, resourceAlert } from '@shared/monitor-resources'
import { effectiveMonitorAsset, daysUntil, trafficUsed, type MonitorNode } from '@shared/monitoring'
import type { ServerMetrics } from '@shared/types'
import { formatBytes } from '../files/FilesView'

export interface MonitorRow { id: string; name: string; group: string; node: MonitorNode; metrics?: ServerMetrics; error?: string }
export const rate = (value?: number) => value === undefined || !Number.isFinite(value) || value < 0 ? '—' : formatBytes(value) + '/s'
export function rowState(row: MonitorRow, now: number): string {
  if (row.error) return '采集异常'
  if (!row.metrics) return '待接入'
  if (now - row.metrics.timestamp > (Math.max(row.node.intervalSeconds ?? 0,row.metrics.intervalSeconds ?? 0) > 0 ? (Math.max(row.node.intervalSeconds ?? 0,row.metrics.intervalSeconds ?? 0)*3+15)*1000:60000)) return '失联'
  if (resourceAlert(row.metrics)) return '资源告警'
  return '正常'
}
export const number = (value?: number, places = 1): string => value === undefined || !Number.isFinite(value) ? '—' : String(Number(value.toFixed(places)))
// Traffic plans are entered as decimal GB. Keep billing totals and usage in that same base.
export function trafficAmount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const [unit, divisor] = bytes >= 1e9 ? ['GB', 1e9] as const : bytes >= 1e6 ? ['MB', 1e6] as const : bytes >= 1e3 ? ['KB', 1e3] as const : ['B', 1] as const
  return `${number(bytes / divisor, 2)} ${unit}`
}
export const trafficQuota = (bytes: number): string => `${number(bytes / 1e9, 2)} GB`
export const capacity = (used?: number, total?: number): string => `${used === undefined ? '—' : formatBytes(used)} / ${total === undefined ? '—' : formatBytes(total)}`
export function uptime(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`
  return `${Math.floor(seconds / 60)} 分钟`
}
export function networkRate(metrics: ServerMetrics | undefined, key: 'rxRate' | 'txRate'): number | undefined {
  const rates = metrics?.network.map(item => item[key]).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0) ?? []
  return rates.length ? rates.reduce((total, value) => total + value, 0) : undefined
}
export function nodeDisplay(row: MonitorRow, now: number) {
  const status = rowState(row, now)
  const sampled = ['正常', '资源告警'].includes(status) ? row.metrics : undefined
  const metrics=sampled?.unavailable?.includes('cpu.usage') ? {...sampled,cpu:{...sampled.cpu,usage:NaN}} : sampled
  const disk = metrics ? mostUsedDisk(metrics.disks) : undefined
  const asset = effectiveMonitorAsset(row.node.asset, row.metrics?.discovered)
  const days = daysUntil(asset.expiresAt, asset.timezone)
  const expiry = days === undefined ? '未填写到期' : days < 0 ? `已过期 ${-days} 天` : days === 0 ? '今天到期' : `${days} 天后到期`
  const price = asset.price ? `${number(asset.price, 2)} ${asset.currency} / ${({ monthly: '月', quarterly: '季', yearly: '年' } as Record<string, string>)[asset.billingCycle] ?? '自定义'}` : ''
  const used = trafficUsed(asset, row.node.periodUpload, row.node.periodDownload)
  const trafficMode = { sum: '上传 + 下载', up: '仅上传', down: '仅下载', max: '上传、下载取大', min: '上传、下载取小' }[asset.trafficMode]
  return { status, metrics, disk, asset, days, expiry, price, used, trafficMode }
}

export function cpuCapacity(metrics?: ServerMetrics): string {
  if (!metrics || !Number.isFinite(metrics.cpu.cores) || metrics.cpu.cores <= 0) return '—'
  const known = !metrics.unavailable?.includes('cpu.usage') && Number.isFinite(metrics.cpu.usage) && metrics.cpu.usage >= 0
  const used = Math.max(0, Math.min(100, metrics.cpu.usage)) / 100 * metrics.cpu.cores
  return `${known ? used > 0 && used < 0.01 ? '<0.01' : number(used, 2) : '—'} / ${metrics.cpu.cores} 核`
}
