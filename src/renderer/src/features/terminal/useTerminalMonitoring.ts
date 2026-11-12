import { useEffect, useState } from 'react'
import type { MonitorSessionInfo } from '@shared/monitoring'
import { useApp } from '../../store/app'

export function useTerminalMonitoring(sessionId: string | undefined, active: boolean) {
  const visible = useApp(state => state.monitoringVisible)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ sessionId?: string; info?: MonitorSessionInfo; error?: string }>({})
  useEffect(() => {
    if (!sessionId || !visible || !active) return
    let cancelled = false
    window.omnidesk.monitoring.sessionInfo(sessionId).then(value => {
      if (!cancelled) setState(value.ok ? { sessionId, info: value.data } : { sessionId, error: value.message })
    }).catch(() => { if (!cancelled) setState({ sessionId, error: '读取监控来源失败，请重试' }) })
    return () => { cancelled = true }
  }, [sessionId, visible, active, revision])
  useEffect(() => {
    const changed = () => setRevision(value => value + 1)
    window.addEventListener('omnidesk:monitor-nodes-changed', changed)
    window.addEventListener('omnidesk:monitoring-changed', changed)
    return () => { window.removeEventListener('omnidesk:monitor-nodes-changed', changed); window.removeEventListener('omnidesk:monitoring-changed', changed) }
  }, [])
  const current = visible && state.sessionId === sessionId ? state : undefined
  return { info: current?.info, error: current?.error, ready: !visible || !!current?.info, refresh: () => setRevision(value => value + 1) }
}
