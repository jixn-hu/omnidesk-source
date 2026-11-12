import type { MonitorLocal, MonitorNode, MonitorAlert } from '@shared/monitoring'

interface MonitorSnapshot { local: MonitorLocal; nodes: MonitorNode[]; alerts: MonitorAlert[]; updatedAt: number; error?: string }
// Memory only: switching pages keeps the last successful result; service changes discard it.
let snapshot: MonitorSnapshot | undefined
let pending: Promise<MonitorSnapshot> | undefined
let generation = 0
export function cachedMonitorSnapshot(): MonitorSnapshot | undefined { return snapshot && structuredClone(snapshot) }
export function clearMonitorSnapshot(): void { generation++; snapshot = undefined; pending = undefined }
window.addEventListener('omnidesk:account-changed', clearMonitorSnapshot)
window.addEventListener('omnidesk:monitoring-changed', clearMonitorSnapshot)
window.addEventListener('omnidesk:monitor-nodes-changed', clearMonitorSnapshot)

export async function refreshMonitorSnapshot(): Promise<MonitorSnapshot> {
  if (pending) return pending
  const currentGeneration = generation
  const check = () => { if (currentGeneration !== generation) throw new Error('监控配置已变更，请重新刷新') }
  const task = (async () => {
    const result = await window.omnidesk.monitoring.local()
    check()
    if (!result.ok) throw new Error(result.message)
    const local = result.data
    if (!local.config.enabled || !local.config.url.trim()) {
      snapshot = undefined
      return { local, nodes: [], alerts: [], updatedAt: 0 }
    }
    // A changed endpoint must never reuse another service's nodes, even on request failure.
    if (snapshot?.local.config.url !== local.config.url || snapshot?.local.config.scopeKey !== local.config.scopeKey) snapshot = undefined
    const [nodes, alerts] = await Promise.all([window.omnidesk.monitoring.nodes(), window.omnidesk.monitoring.alerts()])
    check()
    if (!nodes.ok) return { local, nodes: structuredClone(snapshot?.nodes ?? []), alerts: alerts.ok ? alerts.data : structuredClone(snapshot?.alerts ?? []), updatedAt: snapshot?.updatedAt ?? 0, error: nodes.message }
    snapshot = { local, nodes: nodes.data, alerts: alerts.ok ? alerts.data : snapshot?.alerts ?? [], updatedAt: Date.now() }
    return structuredClone(snapshot)
  })()
  pending = task
  try { return await task } finally { if (pending === task) pending = undefined }
}
