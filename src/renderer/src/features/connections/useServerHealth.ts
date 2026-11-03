import { useEffect, useRef, useState } from 'react'
import type { Connection } from '@shared/types'

export interface ServerHealth {
  reachable: boolean
  timestamp: number
  latencyMs?: number
  probeError?: string
  key: string
}

interface HealthTarget { id: string; key: string }

export function useServerHealth(connections: Connection[], active: boolean) {
  const [health, setHealth] = useState<Record<string, ServerHealth>>({})
  const [enabled, setEnabled] = useState(true)
  const [checking, setChecking] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const pending = useRef(new Set<Promise<void>>())
  const targets = JSON.stringify(connections.map(connection => {
    return { id: connection.id, key: JSON.stringify([connection.host, connection.port, connection.proxy]) }
  }))

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let scanning = false
    const visible = JSON.parse(targets) as HealthTarget[]
    setHealth(current => Object.fromEntries(
      visible.filter(target => current[target.id]?.key === target.key).map(target => [target.id, current[target.id]!])
    ))
    setChecking(false)
    if (!active || !enabled) return

    const sample = async (target: HealthTarget) => {
      const result: ServerHealth = { reachable: false, timestamp: Date.now(), key: target.key }
      try {
        const response = await window.omnidesk.metrics.probe(target.id)
        if (response.ok) Object.assign(result, response.data, { reachable: true })
        else result.probeError = response.message
      } catch (error) { result.probeError = error instanceof Error ? error.message : '端口检查失败' }
      if (cancelled || document.hidden) return
      if (!cancelled) setHealth(current => ({ ...current, [target.id]: result }))
    }
    const run = async () => {
      window.clearTimeout(timer)
      if (cancelled || scanning) return
      if (document.hidden) return
      scanning = true
      setChecking(true)
      let next = 0
      const worker = async () => {
        while (!cancelled && !document.hidden && next < visible.length) {
          while (pending.current.size >= 4) {
            await Promise.race(pending.current)
            if (cancelled || document.hidden) return
          }
          const target = visible[next++]
          if (!target) return
          const operation = sample(target)
          pending.current.add(operation)
          try { await operation } finally { pending.current.delete(operation) }
        }
      }
      try { await Promise.all(Array.from({ length: Math.min(4, visible.length) }, () => worker())) }
      finally {
        scanning = false
        if (!cancelled) {
          setChecking(false)
          timer = window.setTimeout(() => void run(), 30000)
        }
      }
    }
    const onVisible = () => { if (!document.hidden) void run() }
    timer = window.setTimeout(() => void run(), 250)
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [targets, active, enabled, refresh])

  return { health, checking, enabled, setEnabled, refresh: () => setRefresh(current => current + 1) }
}
