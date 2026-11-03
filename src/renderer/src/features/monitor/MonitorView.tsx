import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp, type Tab } from '../../store/app'
import type { ServerMetrics } from '@shared/types'
import { formatBytes } from '../files/FilesView'

/**
 * 服务器监控
 *
 * 数据来自远端采集脚本（内置，推送执行，目标机零依赖）。
 * 这里只负责展示与轮询 —— 数据本身也同时对外暴露给 AI 和 HTTP API。
 */
export default function MonitorView({ tab }: { tab: Tab }) {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [interval, setIntervalMs] = useState(5000)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const [history, setHistory] = useState<ServerMetrics[]>([])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const timerRef = useRef<number | null>(null)

  const sessions = useApp((s) => s.sessions)
  const connections = useApp((s) => s.connections)

  const connection = connections.find((c) => c.id === tab.connectionId)
  const sessionId = sessions.find(item => item.id === tab.sessionId && item.connectionId === tab.connectionId && item.status === 'connected')?.id

  const collect = useCallback(async () => {
    if (!sessionId || inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const response = await window.omnidesk.metrics.collect(sessionId, true)
      if (!mounted.current) return
      if (!response.ok) throw new Error(response.message)
      setMetrics(response.data)
      setHistory(current => [...current.slice(-29), response.data])
      setError('')
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '采样失败') }
    finally { inFlight.current = false; if (mounted.current) setLoading(false) }
  }, [sessionId])

  useEffect(() => {
    void collect()
  }, [collect])

  useEffect(() => {
    if (!autoRefresh || !sessionId) return
    timerRef.current = window.setInterval(() => void collect(), interval)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [autoRefresh, interval, collect, sessionId])

  if (!sessionId) {
    return (
      <div className="empty">
        <div className="empty-title">SSH 会话已断开</div>
        <div className="empty-desc">请先连接 SSH，再从终端右侧点击「状态」查看系统资源。监控只复用当前登录会话，不自动登录或检查其他服务器。</div>
      </div>
    )
  }

  return (
    <div className="files-layout">
      <div className="toolbar">
        <span className="toolbar-title">{connection?.name}</span>
        <span className="toolbar-sub">
          {metrics ? `${metrics.system.hostname} · ${metrics.system.os}` : ''}
        </span>
        <span className="toolbar-spacer" />

        <label
          style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-secondary)' }}
        >
          <button
            className="switch"
            data-on={autoRefresh}
            onClick={() => setAutoRefresh((v) => !v)}
            aria-label="自动刷新"
          />
          自动刷新
        </label>

        <select
          value={interval}
          onChange={(e) => setIntervalMs(Number(e.target.value))}
          style={{ width: 'auto', height: 26, fontSize: 12, padding: '0 6px' }}
        >
          <option value={2000}>2 秒</option>
          <option value={5000}>5 秒</option>
          <option value={10000}>10 秒</option>
          <option value={30000}>30 秒</option>
        </select>

        <button className="btn btn-sm" onClick={() => void collect()} disabled={loading}>
          立即刷新
        </button>
      </div>

      <div className="pane">
        {error && (
          <div className="alert alert-danger" style={{ marginBottom: 16 }}>
            <span>⚠</span>
            <div>
              <strong>采集失败：</strong>
              {error}
              <div className="field-hint" style={{ marginTop: 6 }}>
                Linux 需要 sh 与可写的 ~/.omnidesk/；Windows 需要 OpenSSH、PowerShell 及 CIM / 网卡统计读取权限。
              </div>
            </div>
          </div>
        )}

        {!metrics && loading && (
          <div className="empty">
            <div className="spinner" />
            <div className="empty-desc">正在采集…</div>
          </div>
        )}

        {metrics && (
          <>
            <div className="monitor-trends">
              <div><span>SSH 响应</span><strong>{metrics.latencyMs ?? '—'} ms</strong><small>含命令启动时间 · {new Date(metrics.timestamp).toLocaleTimeString()}</small></div>
              <Trend label="CPU · 最近 30 次" values={history.map(item => item.cpu.usage)} unit="%" ceiling={100} />
              <Trend label="接收流量" values={history.map(item => item.network.reduce((total, adapter) => total + (adapter.rxRate ?? 0), 0))} unit="B/s" />
              <Trend label="发送流量" values={history.map(item => item.network.reduce((total, adapter) => total + (adapter.txRate ?? 0), 0))} unit="B/s" />
            </div>
            {/* 概览 */}
            <div className="monitor-grid">
              <div className="metric-card">
                <div className="metric-label">CPU 使用率</div>
                <div className="metric-value">
                  {metrics.cpu.usage.toFixed(1)}
                  <span className="metric-unit">%</span>
                </div>
                <div className="bar">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.min(metrics.cpu.usage, 100)}%`,
                      background: usageColor(metrics.cpu.usage)
                    }}
                  />
                </div>
                <div className="metric-sub">
                  {metrics.cpu.cores} 核 · 负载 {metrics.cpu.loadAvg.join(' / ')}
                </div>
                {metrics.cpu.perCore.length > 0 && metrics.cpu.perCore.length <= 64 && (
                  <div className="core-grid">
                    {metrics.cpu.perCore.map((v, i) => (
                      <div
                        key={i}
                        className="core-bar"
                        style={{
                          height: `${Math.max(Math.min(v, 100), 4)}%`,
                          background: usageColor(v)
                        }}
                        title={`核心 ${i}：${v}%`}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="metric-card">
                <div className="metric-label">内存</div>
                <div className="metric-value">
                  {metrics.memory.usagePercent.toFixed(1)}
                  <span className="metric-unit">%</span>
                </div>
                <div className="bar">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.min(metrics.memory.usagePercent, 100)}%`,
                      background: usageColor(metrics.memory.usagePercent)
                    }}
                  />
                </div>
                <div className="metric-sub">
                  {formatBytes(metrics.memory.used)} / {formatBytes(metrics.memory.total)}
                </div>
                {metrics.memory.swapTotal > 0 && (
                  <div className="metric-sub">
                    Swap {formatBytes(metrics.memory.swapUsed)} / {formatBytes(metrics.memory.swapTotal)}
                  </div>
                )}
              </div>

              <div className="metric-card">
                <div className="metric-label">运行时长</div>
                <div className="metric-value">{formatUptime(metrics.system.uptime)}</div>
                <div className="metric-sub">
                  {metrics.system.kernel}
                  {metrics.system.virtualization ? ` · ${metrics.system.virtualization}` : ''}
                </div>
                <div className="metric-sub">{metrics.system.arch}</div>
              </div>
            </div>

            {/* 磁盘 */}
            {metrics.disks.length > 0 && (
              <>
                <h3 className="card-title" style={{ margin: '18px 0 10px' }}>
                  磁盘
                </h3>
                <div className="card" style={{ padding: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>挂载点</th>
                        <th>设备</th>
                        <th style={{ textAlign: 'right' }}>已用</th>
                        <th style={{ textAlign: 'right' }}>总量</th>
                        <th style={{ width: 160 }}>使用率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.disks.map((d) => (
                        <tr key={d.mount}>
                          <td className="mono">{d.mount}</td>
                          <td className="mono" style={{ color: 'var(--text-tertiary)' }}>
                            {d.device}
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {formatBytes(d.used)}
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {formatBytes(d.total)}
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div className="bar" style={{ flex: 1, marginTop: 0 }}>
                                <div
                                  className="bar-fill"
                                  style={{
                                    width: `${Math.min(d.usagePercent, 100)}%`,
                                    background: usageColor(d.usagePercent)
                                  }}
                                />
                              </div>
                              <span
                                className="mono"
                                style={{ fontSize: 11.5, width: 42, textAlign: 'right' }}
                              >
                                {d.usagePercent.toFixed(0)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* 网络 */}
            {metrics.network.length > 0 && (
              <>
                <h3 className="card-title" style={{ margin: '18px 0 10px' }}>
                  网络
                </h3>
                <div className="card" style={{ padding: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>网卡</th>
                        <th style={{ textAlign: 'right' }}>接收</th>
                        <th style={{ textAlign: 'right' }}>发送</th>
                        <th style={{ textAlign: 'right' }}>实时速率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.network.map((n) => (
                        <tr key={n.name}>
                          <td className="mono">{n.name}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {formatBytes(n.rxBytes)}
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {formatBytes(n.txBytes)}
                          </td>
                          <td className="mono" style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                            {n.rxRate != null ? `↓${formatRate(n.rxRate)} ↑${formatRate(n.txRate ?? 0)}` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* 进程 */}
            {metrics.processes && metrics.processes.length > 0 && (
              <>
                <h3 className="card-title" style={{ margin: '18px 0 10px' }}>
                  CPU 占用最高的进程
                </h3>
                <div className="card" style={{ padding: 0 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 70 }}>PID</th>
                        <th style={{ width: 110 }}>用户</th>
                        <th style={{ width: 70, textAlign: 'right' }}>CPU</th>
                        <th style={{ width: 70, textAlign: 'right' }}>内存</th>
                        <th>命令</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.processes.map((p) => (
                        <tr key={p.pid}>
                          <td className="mono">{p.pid}</td>
                          <td className="mono" style={{ color: 'var(--text-secondary)' }}>
                            {p.user}
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {p.cpu.toFixed(1)}%
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {p.mem.toFixed(1)}%
                          </td>
                          <td
                            className="mono"
                            style={{
                              color: 'var(--text-secondary)',
                              maxWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                            title={p.command}
                          >
                            {p.command}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div
              style={{
                marginTop: 16,
                fontSize: 11.5,
                color: 'var(--text-tertiary)',
                textAlign: 'right'
              }}
            >
              采集于 {new Date(metrics.timestamp).toLocaleTimeString()} · 耗时 {metrics.durationMs}ms
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function usageColor(pct: number): string {
  if (pct >= 90) return 'var(--danger)'
  if (pct >= 75) return 'var(--warning)'
  return 'var(--accent)'
}

function formatUptime(seconds: number): string {
  if (!seconds) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分钟`
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`
}

function Trend({ label, values, unit, ceiling }: { label: string; values: number[]; unit: string; ceiling?: number }) {
  const maximum = ceiling ?? Math.max(1, ...values)
  const points = values.map((value, index) => `${index * 120 / Math.max(1, values.length - 1)},${30 - Math.min(1, value / maximum) * 28}`).join(' ')
  const latest = values.at(-1) ?? 0
  return <div><span>{label}</span><strong>{unit === '%' ? latest.toFixed(1) + '%' : formatBytes(latest) + '/s'}</strong><svg viewBox="0 0 120 32" role="img" aria-label={label}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" /></svg></div>
}
