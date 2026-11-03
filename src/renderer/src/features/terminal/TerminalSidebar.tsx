import { useEffect, useState } from 'react'
import { useApp, type Tab } from '../../store/app'
import Icon from '../../components/Icon'
import FilesView, { formatBytes } from '../files/FilesView'
import { useSessionMetrics } from './useSessionMetrics'

type Panel = 'status' | 'files' | null

export default function TerminalSidebar({ tab, active, connected }: { tab: Tab; active: boolean; connected: boolean }) {
  const [panel, setPanel] = useState<Panel>(() => localStorage.getItem('omnidesk.terminal.sidebar') === 'files' ? 'files' : null)
  const [filesOpened, setFilesOpened] = useState(panel === 'files')
  const sessionId = connected ? tab.sessionId : undefined
  const status = useSessionMetrics(sessionId, active && panel === 'status')
  const openTab = useApp(state => state.openTab)
  const select = (next: Panel) => {
    setPanel(next)
    if (next === 'files') setFilesOpened(true)
    localStorage.setItem('omnidesk.terminal.sidebar', next === 'files' ? 'files' : 'closed')
  }
  useEffect(() => {
    if (!connected) setPanel(current => current === 'status' ? null : current)
  }, [connected])
  const metrics = status.metrics
  const network = metrics?.network ?? []
  const hasRates = network.some(adapter => adapter.rxRate !== undefined || adapter.txRate !== undefined)
  const received = network.reduce((total, adapter) => total + (adapter.rxRate ?? 0), 0)
  const sent = network.reduce((total, adapter) => total + (adapter.txRate ?? 0), 0)
  const contentId = `ssh-tools-${tab.id}`

  return <aside className={`terminal-sidebar ${panel ? 'is-open' : ''}`} aria-label="SSH 会话工具">
    <section className="terminal-sidebar-panel" hidden={!panel} id={contentId} aria-label={panel === 'status' ? '系统状态面板' : '文件管理面板'}>
      <header className="terminal-sidebar-header"><div><strong>{panel === 'status' ? '系统状态' : '远程文件'}</strong><span>{panel === 'status' ? '当前 SSH 会话 · 5 秒自动采样' : 'SFTP · 复用当前会话'}</span></div>
        <button className="btn btn-ghost btn-icon" aria-label={panel === 'status' ? '独立打开监控' : '独立打开文件管理'} title="在独立标签页打开" disabled={!sessionId} onClick={() => openTab({ kind: panel === 'status' ? 'monitor' : 'files', title: tab.title + (panel === 'status' ? ' · 监控' : ' · 文件'), connectionId: tab.connectionId, sessionId, status: 'idle' })}><Icon name="expand" size={14} /></button>
        <button className="btn btn-ghost btn-icon" aria-label="折叠会话侧栏" title="折叠侧栏，扩大终端" onClick={() => select(null)}><Icon name="chevron" size={15} /></button>
      </header>
      <div className="terminal-sidebar-content" hidden={panel !== 'status'}>
        {!sessionId ? <div className="terminal-sidebar-empty"><Icon name="server" size={28} /><strong>连接后点击「状态」查看</strong><span>复用当前 SSH 会话，不额外登录服务器。</span></div> : <>
          <div className="terminal-metrics-heading"><span className={`dot ${status.error ? 'dot-error' : 'dot-connected'}`} /><span>{status.error ? '采样异常' : status.loading ? '正在采样' : metrics ? '运行中' : '等待采样'}</span><time>{metrics ? new Date(metrics.timestamp).toLocaleTimeString() : '—'}</time><button className="btn btn-ghost btn-icon" aria-label="刷新系统状态" title="刷新状态" disabled={status.loading} onClick={status.refresh}><Icon name="refresh" size={14} /></button></div>
          {status.error && <div className="terminal-metrics-error" role="alert"><strong>状态采集失败，终端仍可正常使用</strong><span>{status.error}</span>{metrics && <small>以下保留上次成功采样的数据。</small>}</div>}
          {!metrics && !status.error && <div className="terminal-sidebar-empty"><div className="spinner" /><span>正在读取服务器状态…</span></div>}
          {metrics && <>
            <div className="terminal-system"><strong title={metrics.system.hostname}>{metrics.system.hostname}</strong><span>{metrics.system.os}</span><small>{metrics.system.arch} · 已运行 {uptime(metrics.system.uptime)}</small></div>
            <div className="terminal-metric-pair"><Meter label="CPU" value={metrics.cpu.usage} detail={`${metrics.cpu.cores} 核`} /><Meter label="内存" value={metrics.memory.usagePercent} detail={`${formatBytes(metrics.memory.used)} / ${formatBytes(metrics.memory.total)}`} /></div>
            <div className="terminal-cpu-history"><span>CPU 趋势<small>最近 {status.history.length} 次</small></span><svg viewBox="0 0 240 32" preserveAspectRatio="none" role="img" aria-label="CPU 使用率趋势"><polyline fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={status.history.map((value, index) => `${index * 240 / Math.max(1, status.history.length - 1)},${31 - Math.max(0, Math.min(100, value)) * .3}`).join(' ')} /></svg></div>
            <div className="terminal-network-summary"><div><span>↓ 接收</span><strong>{hasRates ? `${formatBytes(received)}/s` : '采样中…'}</strong></div><div><span>↑ 发送</span><strong>{hasRates ? `${formatBytes(sent)}/s` : '采样中…'}</strong></div></div>
            <div className="terminal-metric-line"><span>SSH 响应</span><strong title="采集命令往返时间，并非 ICMP Ping">{metrics.latencyMs === undefined ? '—' : `${metrics.latencyMs} ms`}</strong></div>
            <details className="terminal-metric-details" open><summary>磁盘<span>{metrics.disks.length} 个挂载点</span></summary><div>{metrics.disks.map(disk => <Meter key={`${disk.device}:${disk.mount}`} label={disk.mount} value={disk.usagePercent} detail={`${formatBytes(disk.used)} / ${formatBytes(disk.total)}`} />)}</div></details>
            <details className="terminal-metric-details"><summary>网络接口<span>{network.length} 个</span></summary><div>{network.map(adapter => <div className="terminal-interface" key={adapter.name}><strong>{adapter.name}</strong><span>↓ {adapter.rxRate === undefined ? '—' : `${formatBytes(adapter.rxRate)}/s`} · ↑ {adapter.txRate === undefined ? '—' : `${formatBytes(adapter.txRate)}/s`}</span><small>累计 ↓ {formatBytes(adapter.rxBytes)} · ↑ {formatBytes(adapter.txBytes)}</small></div>)}</div></details>
            <details className="terminal-metric-details"><summary>系统详情</summary><dl><dt>内核</dt><dd>{metrics.system.kernel}</dd><dt>负载 1 / 5 / 15 分钟</dt><dd>{metrics.cpu.loadAvg.map(value => value.toFixed(2)).join(' / ')}</dd><dt>Swap</dt><dd>{formatBytes(metrics.memory.swapUsed)} / {formatBytes(metrics.memory.swapTotal)}</dd></dl></details>
          </>}
        </>}
      </div>
      <div className="terminal-sidebar-files" hidden={panel !== 'files'}>
        {!sessionId ? <div className="terminal-sidebar-empty"><Icon name="folder" size={28} /><strong>连接后可管理文件</strong><span>浏览目录、上传下载，无需离开终端。</span></div> : filesOpened && <FilesView key={sessionId} tab={{ ...tab, kind: 'files', sessionId }} compact active={active && panel === 'files'} />}
      </div>
    </section>
    <nav className="terminal-sidebar-rail" aria-label="会话侧栏切换">
      <button aria-label="系统状态" aria-expanded={panel === 'status'} aria-controls={panel === 'status' ? contentId : undefined} disabled={!sessionId} title={sessionId ? '系统状态 · 再次点击折叠' : '连接 SSH 后可查看系统状态'} onClick={() => select(panel === 'status' ? null : 'status')}><Icon name="server" size={17} /><span>状态</span></button>
      <button aria-label="文件管理" aria-expanded={panel === 'files'} aria-controls={panel === 'files' ? contentId : undefined} title="文件管理 · 再次点击折叠" onClick={() => select(panel === 'files' ? null : 'files')}><Icon name="folder" size={17} /><span>文件</span></button>
    </nav>
  </aside>
}

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  return <div className="terminal-resource-meter"><div><span title={label}>{label}</span><strong>{percent.toFixed(1)}<small>%</small></strong></div><div className="terminal-resource-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span data-high={percent >= 85} style={{ width: `${percent}%` }} /></div><small>{detail}</small></div>
}

function uptime(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60))
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时` : minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
}
