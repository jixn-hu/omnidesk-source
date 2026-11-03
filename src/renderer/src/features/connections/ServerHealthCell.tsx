import type { ServerHealth } from './useServerHealth'

export default function ServerHealthCell({ health, connected }: { health?: ServerHealth; connected: boolean }) {
  const state = connected ? 'connected' : health ? health.reachable ? 'reachable' : 'unreachable' : 'unknown'

  return <div className="server-health-cell">
    <div className="server-health-state" data-state={state} title={health?.probeError || 'TCP 端口可达不代表 SSH / RDP 认证成功'}><span className="server-health-dot" /><span className="server-health-label">{connected ? 'SSH 已连接' : health ? health.reachable ? '端口可达' : '端口不可达' : '待检测'}</span><span className="server-health-latency" title="TCP 建连时间，包含代理连接；不是 ICMP Ping">{health?.latencyMs !== undefined ? `${health.latencyMs} ms` : '—'}</span></div>
    {health && <time dateTime={new Date(health.timestamp).toISOString()}>{new Date(health.timestamp).toLocaleTimeString()}</time>}
  </div>
}
