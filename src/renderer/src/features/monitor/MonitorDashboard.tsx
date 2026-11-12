import { cachedMonitorSnapshot, refreshMonitorSnapshot, clearMonitorSnapshot } from './monitor-cache'
import { useEffect, useMemo, useState } from 'react'
import { effectiveMonitorAsset, daysUntil, type MonitorLocal, type MonitorNode, type MonitorAlert } from '@shared/monitoring'
import Icon from '../../components/Icon'
import { useApp } from '../../store/app'
import MonitorAssetEditor from './MonitorAssetEditor'
import MonitorDetail from './MonitorDetail'
import MonitorAgentDialog from './MonitorAgentDialog'
import MonitorDeleteDialog from './MonitorDeleteDialog'
import { rowState, nodeDisplay, type MonitorRow } from './monitor-display'
import { MonitorCards, MonitorList } from './MonitorNodeViews'
import './monitoring.css'

export default function MonitorDashboard({ initialNodeId }: { initialNodeId?: string }) {
  const [cached] = useState(cachedMonitorSnapshot)
  const [local, setLocal] = useState<MonitorLocal>(cached?.local ?? { config: { enabled: false, url: '', allowInsecure: false, hasToken: false }, entries: [] })
  const [nodes, setNodes] = useState<MonitorNode[]>(cached?.nodes ?? []), [alerts, setAlerts] = useState<MonitorAlert[]>(cached?.alerts ?? [])
  const [serviceError, setServiceError] = useState(''), [loading, setLoading] = useState(true)
  const [view, setView] = useState<'cards' | 'list'>(() => localStorage.getItem('omnidesk.monitor.view') === 'list' ? 'list' : 'cards')
  const changeView = (next: 'cards' | 'list') => { setView(next); localStorage.setItem('omnidesk.monitor.view', next) }
  const [query, setQuery] = useState(''), [group, setGroup] = useState(''), [sort, setSort] = useState('status'), [revision, setRevision] = useState(0), [now, setNow] = useState(Date.now())
  const [selected, setSelected] = useState<string | undefined>(initialNodeId), [editor, setEditor] = useState<{ node: MonitorNode }>()
  const [installer, setInstaller] = useState<{ node?: MonitorNode }>(), [removing, setRemoving] = useState<MonitorNode>()
  useEffect(() => {
    let cancelled = false, running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const sample = async () => {
      if (cancelled || running || document.hidden) return
      running = true
      setLoading(true)
      try {
        const snapshot = await refreshMonitorSnapshot()
        if (cancelled) return
        setLocal(snapshot.local); setNodes(snapshot.nodes); setAlerts(snapshot.alerts)
        setServiceError(snapshot.error ?? ''); setNow(Date.now())
      } catch (error) { if (!cancelled) setServiceError(error instanceof Error ? error.message : '读取监控失败') }
      finally { running = false; if (!cancelled) { setLoading(false); if (!document.hidden) timer = setTimeout(() => void sample(), 10000) } }
    }
    const refresh = () => { clearTimeout(timer); if (!document.hidden) void sample() }
    const changed = () => setRevision(value => value + 1)
    const configured = () => { setLocal({ config: { enabled: false, url: '', allowInsecure: false, hasToken: false }, entries: [] }); setNodes([]); setAlerts([]); setServiceError(''); changed() }
    void sample(); document.addEventListener('visibilitychange', refresh); window.addEventListener('omnidesk:monitoring-changed', configured); window.addEventListener('omnidesk:monitor-nodes-changed', changed)
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('omnidesk:monitoring-changed', configured); window.removeEventListener('omnidesk:monitor-nodes-changed', changed) }
  }, [revision])
  const rows = useMemo<MonitorRow[]>(() => local.config.enabled && local.config.url.trim() ? nodes.map(node => ({ id: node.id, name: node.name, group: node.group, node, metrics: node.metrics, error: serviceError })) : [], [local.config.enabled, local.config.url, nodes, serviceError])
  const matched = rows.filter(row => (!query || `${row.name} ${row.group} ${row.metrics?.system.hostname ?? ''} ${row.metrics?.discovered?.ip ?? ''} ${effectiveMonitorAsset(row.node.asset, row.metrics?.discovered).provider} ${effectiveMonitorAsset(row.node.asset, row.metrics?.discovered).region}`.toLowerCase().includes(query.toLowerCase())) && (!group || (row.group || '未分组') === group)).sort((a, b) => {
    if (['cpu', 'memory', 'disk'].includes(sort)) {
      const value = (row: MonitorRow) => {
        const display = nodeDisplay(row, now)
        const reading = sort === 'cpu' ? display.metrics?.cpu.usage : sort === 'memory' ? display.metrics?.memory.usagePercent : display.disk?.usagePercent
        return typeof reading === 'number' && Number.isFinite(reading) ? reading : -1
      }
      return value(b) - value(a)
    }
    if (sort === 'expiry') return (daysUntil(a.node.asset.expiresAt, a.node.asset.timezone) ?? Infinity) - (daysUntil(b.node.asset.expiresAt, b.node.asset.timezone) ?? Infinity)
    if (sort === 'status') { const rank = (r: MonitorRow) => ['正常', '待接入', '资源告警', '失联', '采集异常'].indexOf(rowState(r, now)); const d = rank(b) - rank(a); if (d) return d }
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  const detail = rows.find(row => row.id === selected)
  const refresh = () => setRevision(value => value + 1)
  const mutated = () => { clearMonitorSnapshot(); refresh() }
  const edit = (row: MonitorRow) => setEditor({ node: row.node })
  return <div className="monitor-dashboard">
    <header className="monitor-page-header"><div><h1>服务器监控</h1><p>{detail ? detail.name : '集中查看资源、流量与到期日期'}</p></div><div className="monitor-actions"><button className="btn btn-sm" onClick={refresh} disabled={loading}>{loading ? '更新中…' : '刷新'}</button><button className="btn btn-sm" onClick={() => useApp.setState({ monitorBatchConnectionIds: [] })}>批量安装采集端</button><button className="btn btn-primary btn-sm" disabled={!local.config.enabled || !local.config.url} onClick={() => setInstaller({})}><Icon name="plus" size={14} />添加监控服务器</button></div></header>
    {serviceError && <div className="alert alert-danger" role="alert">{serviceError}</div>}
    {detail ? <MonitorDetail key={detail.id} row={detail} now={now} onBack={() => setSelected(undefined)} onEdit={() => edit(detail)} onInstall={() => setInstaller({ node: detail.node })} onDelete={() => setRemoving(detail.node)} /> : <>
      <div className="monitor-summary"><span>已加入 <strong>{rows.length}</strong></span><span><i className="monitor-dot" />正常 <strong>{rows.filter(row => rowState(row, now) === '正常').length}</strong></span><span>异常 <strong className="monitor-warning">{rows.filter(row => ['失联', '采集异常', '资源告警'].includes(rowState(row, now))).length}</strong></span><span>即将到期 <strong>{rows.filter(row => { const a = row.node.asset; const days = a && daysUntil(a.expiresAt, a.timezone); return days !== undefined && days <= 7 }).length}</strong></span><small>{loading && rows.length ? '后台更新中 · 显示上次数据' : '10 秒刷新 · 后台采集'}</small></div>
      <div className="monitor-filters"><input aria-label="搜索监控服务器" placeholder="搜索名称、IP、分组、服务商或地区" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="监控分组" value={group} onChange={event => setGroup(event.target.value)}><option value="">全部分组</option>{[...new Set(rows.map(row => row.group || '未分组'))].sort().map(value => <option key={value}>{value}</option>)}</select><select aria-label="监控排序" value={sort} onChange={event => setSort(event.target.value)}><option value="status">异常优先</option><option value="name">按名称</option><option value="cpu">CPU 占用</option><option value="memory">内存占用</option><option value="disk">磁盘占用</option><option value="expiry">到期时间</option></select><div className="monitor-view-switch" role="group" aria-label="监控显示方式"><button aria-label="卡片视图" aria-pressed={view === 'cards'} onClick={() => changeView('cards')}><Icon name="grid" size={14} />卡片</button><button aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => changeView('list')}><Icon name="list" size={14} />列表</button></div></div>
      {matched.length > 0 ? view === 'cards'
        ? <MonitorCards rows={matched} now={now} onDetail={row => setSelected(row.id)} onEdit={edit} onInstall={row => setInstaller({ node: row.node })} onDelete={row => setRemoving(row.node)} />
        : <MonitorList rows={matched} now={now} onDetail={row => setSelected(row.id)} onEdit={edit} onInstall={row => setInstaller({ node: row.node })} onDelete={row => setRemoving(row.node)} />
        : <div className="monitor-empty empty"><Icon name={query || group ? 'search' : 'activity'} size={28} /><div className="empty-title">{loading ? '正在读取监控…' : rows.length ? '没有匹配的服务器' : '还没有加入监控的服务器'}</div><p className="empty-desc">{rows.length ? '试试其他关键词，或切换分组。' : '连接 Linux SSH 后点击终端侧面的「加入监控」，或在这里选择已保存的 SSH 服务器。'}</p></div>}
      <p className="monitor-footnote">后台采集独立于终端连接持续运行。流量为监测值，套餐结算以商家口径为准。</p>
      {local.config.enabled && alerts.length > 0 && <details className="monitor-alerts"><summary>服务端提醒记录 · {alerts.length}</summary>{alerts.slice(0, 30).map(alert => <div key={alert.id}><time>{new Date(alert.timestamp).toLocaleString()}</time><span>{alert.message}</span></div>)}</details>}
    </>}
    {installer && <MonitorAgentDialog node={installer.node} onClose={() => setInstaller(undefined)} onChanged={mutated} />}
    {removing && <MonitorDeleteDialog node={removing} onClose={() => setRemoving(undefined)} onDeleted={() => { setNodes(current => current.filter(node => node.id !== removing.id)); if (selected === removing.id) setSelected(undefined); setRemoving(undefined); refresh() }} />}
    {editor && <MonitorAssetEditor node={nodes.find(item => item.id === editor.node?.id) ?? editor.node} onClose={() => setEditor(undefined)} onSaved={mutated} />}
  </div>
}
