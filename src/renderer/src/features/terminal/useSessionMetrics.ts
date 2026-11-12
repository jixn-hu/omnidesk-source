import { useApp } from '../../store/app'
import { useEffect, useRef, useState } from 'react'
import type { IpcResult, ServerMetrics } from '@shared/types'

interface MetricsSnapshot {
  scope?: string
  sessionId?: string
  nodeId?: string
  metrics?: ServerMetrics
  history: number[]
  loading: boolean
  error: string
}

export function useSessionMetrics(sessionId: string | undefined, enabled: boolean, nodeId?: string) {
  const scope=useApp(state=>state.accountServerUrl+'|'+(state.accountUser?.id??''))
  const [snapshot, setSnapshot] = useState<MetricsSnapshot>({ history: [], loading: false, error: '' })
  const [revision, setRevision] = useState(0)
  const pending = useRef<{ sessionId: string; nodeId?: string; operation: Promise<IpcResult<ServerMetrics>> }>()

  useEffect(()=>{if(nodeId){pending.current=undefined;setSnapshot({history:[],loading:false,error:''})}},[scope])

  useEffect(() => {
    if (!sessionId || !enabled) return
    let cancelled = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sample = async () => {
      if (cancelled || running || document.hidden) return
      running = true
      setSnapshot(current => current.sessionId === sessionId && current.nodeId === nodeId ? { ...current, loading: true } : { sessionId, nodeId, history: [], loading: true, error: '' })
      const operation: Promise<IpcResult<ServerMetrics>> = pending.current?.sessionId === sessionId && pending.current.nodeId === nodeId ? pending.current.operation : nodeId
        ? window.omnidesk.monitoring.nodes().then(result => {
          if (!result.ok) return result
          const node = result.data.find(item => item.id === nodeId)
          if (!node) return { ok: false, code: 'NOT_FOUND', message: '监控节点已不存在，请刷新连接状态' }
          if (!node.metrics) return { ok: false, code: 'WAITING', message: '等待后台采集端首次上报' }
          return { ok: true, data: {...node.metrics,intervalSeconds:Math.max(node.intervalSeconds??0,node.metrics.intervalSeconds??0)} }
        })
        : window.omnidesk.metrics.collect(sessionId, false)
      pending.current = { sessionId, nodeId, operation }
      try {
        const result = await operation
        if (cancelled) return
        if (!result.ok) throw new Error(result.message)
        setSnapshot(current => ({ sessionId, nodeId, scope, metrics: result.data, history: current.sessionId === sessionId && current.nodeId === nodeId && current.metrics?.timestamp === result.data.timestamp ? current.history : [...(current.sessionId === sessionId && current.nodeId === nodeId ? current.history : []).slice(-23), result.data.cpu.usage], loading: false, error: nodeId && Date.now() - result.data.timestamp > (result.data.intervalSeconds ? (result.data.intervalSeconds*3+15)*1000:60000) ? '后台采集数据已失联，以下保留上次上报' : '' }))
      } catch (error) {
        if (!cancelled) setSnapshot(current => ({ ...current, sessionId, nodeId, loading: false, error: error instanceof Error ? error.message : '状态采集失败' }))
      } finally {
        if (pending.current?.operation === operation) pending.current = undefined
        running = false
        if (!cancelled && !document.hidden) timer = setTimeout(() => void sample(), nodeId ? 10000 : 5000)
      }
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void sample()
    }
    void sample()
    document.addEventListener('visibilitychange', visibility)
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [sessionId, enabled, revision, nodeId, scope])

  const current: MetricsSnapshot = snapshot.sessionId === sessionId && snapshot.nodeId === nodeId && (!nodeId || snapshot.scope===scope) ? snapshot : { history: [], loading: false, error: '' }
  return { ...current, refresh: () => setRevision(value => value + 1) }
}
