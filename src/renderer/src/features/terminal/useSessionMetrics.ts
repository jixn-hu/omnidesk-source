import { useEffect, useRef, useState } from 'react'
import type { IpcResult, ServerMetrics } from '@shared/types'

interface MetricsSnapshot {
  sessionId?: string
  metrics?: ServerMetrics
  history: number[]
  loading: boolean
  error: string
}

export function useSessionMetrics(sessionId: string | undefined, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot>({ history: [], loading: false, error: '' })
  const [revision, setRevision] = useState(0)
  const pending = useRef<{ sessionId: string; operation: Promise<IpcResult<ServerMetrics>> }>()

  useEffect(() => {
    if (!sessionId || !enabled) return
    let cancelled = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sample = async () => {
      if (cancelled || running || document.hidden) return
      running = true
      setSnapshot(current => current.sessionId === sessionId ? { ...current, loading: true } : { sessionId, history: [], loading: true, error: '' })
      const operation = pending.current?.sessionId === sessionId ? pending.current.operation : window.omnidesk.metrics.collect(sessionId, false)
      pending.current = { sessionId, operation }
      try {
        const result = await operation
        if (cancelled) return
        if (!result.ok) throw new Error(result.message)
        setSnapshot(current => ({ sessionId, metrics: result.data, history: [...(current.sessionId === sessionId ? current.history : []).slice(-23), result.data.cpu.usage], loading: false, error: '' }))
      } catch (error) {
        if (!cancelled) setSnapshot(current => ({ ...current, sessionId, loading: false, error: error instanceof Error ? error.message : '状态采集失败' }))
      } finally {
        if (pending.current?.operation === operation) pending.current = undefined
        running = false
        if (!cancelled && !document.hidden) timer = setTimeout(() => void sample(), 5000)
      }
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void sample()
    }
    void sample()
    document.addEventListener('visibilitychange', visibility)
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [sessionId, enabled, revision])

  const current: MetricsSnapshot = snapshot.sessionId === sessionId ? snapshot : { history: [], loading: false, error: '' }
  return { ...current, refresh: () => setRevision(value => value + 1) }
}
