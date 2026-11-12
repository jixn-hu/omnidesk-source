import { useMemo, useState } from 'react'
import { formatConnectionAddress, matchesConnection } from '@shared/connection-identity'
import { useApp } from '../../store/app'
import type { Connection } from '@shared/types'
import Icon from '../../components/Icon'
import ConnectionCheckBadge from '../../components/ConnectionCheckBadge'
import CredentialTest from '../credentials/CredentialTest'
import { useServerHealth } from './useServerHealth'
import BatchMetadataEditor from './BatchMetadataEditor'
import { TagPill } from '../../components/TagInput'
import ServerHealthCell from './ServerHealthCell'

export default function ServersView({ onEdit, onNew, onImport, active }: { onEdit: (id: string) => void; onNew: () => void; onImport: () => void; active: boolean }) {
  const connections = useApp(state => state.connections)
  const checks = useApp(state => state.connectionChecks)
  const tabs = useApp(state => state.tabs)
  const sessions = useApp(state => state.sessions)
  const openTab = useApp(state => state.openTab)
  const [query, setQuery] = useState('')
  const [protocol, setProtocol] = useState('')
  const [group, setGroup] = useState('')
  const [incompleteOnly, setIncompleteOnly] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [batch, setBatch] = useState<Connection[] | null>(null)
  const [message, setMessage] = useState('')
  const [testing, setTesting] = useState(false)
  const groups = [...new Set(connections.map(item => item.group || '未分组'))].sort()
  const incompleteCount = connections.filter(item => checks[item.id]?.issues.length).length
  const matched = useMemo(() => connections.filter(item => matchesConnection(item, query) && (!protocol || item.kind === protocol) && (!group || (item.group || '未分组') === group) && (!incompleteOnly || checks[item.id]?.issues.length)).sort((first, second) => (first.group ?? '').localeCompare(second.group ?? '', 'zh-CN') || first.name.localeCompare(second.name, 'zh-CN')), [connections, query, protocol, group, incompleteOnly, checks])
  const lastPage = Math.max(0, Math.ceil(matched.length / 50) - 1)
  const currentPage = Math.min(page, lastPage)
  const visible = matched.slice(currentPage * 50, (currentPage + 1) * 50)
  const monitoring = useServerHealth(visible, active)
  const reachable = visible.filter(item => monitoring.health[item.id]?.reachable).length
  const unreachable = visible.filter(item => monitoring.health[item.id] && !monitoring.health[item.id]!.reachable).length
  const picked = connections.filter(item => selected.has(item.id))
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const open = (connection: Connection, newSession = false) => openTab({ kind: connection.kind, title: connection.name, connectionId: connection.id, status: 'idle', newSession })
  return <div className="server-manager">
    <div className="server-heading"><div><span className="eyebrow">INVENTORY</span><h1>服务器管理</h1><p>按用途分组，用标签与备注快速定位。连接配置只需一份，会话可以独立打开。</p></div><div className="server-heading-actions"><span className="server-count">{connections.length}<small>台服务器</small></span><div><button className="btn" onClick={onImport} title="从 XTerminal 或 Remote Desktop Organizer 导入"><Icon name="import" size={15} />导入连接</button><button className="btn btn-primary" onClick={onNew}><Icon name="plus" size={15} />新建连接</button></div></div></div>
    <div className="server-filters">
      <label className="server-search"><Icon name="search" size={17} /><input aria-label="搜索所有服务器" placeholder="名称、地址、账号、备注、标签…" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} /></label>
      <select aria-label="协议筛选" value={protocol} onChange={event => { setProtocol(event.target.value); setPage(0) }}><option value="">全部协议</option><option value="ssh">SSH</option><option value="rdp">RDP</option></select>
      <select aria-label="分组筛选" value={group} onChange={event => { setGroup(event.target.value); setPage(0) }}><option value="">全部分组</option>{groups.map(name => <option key={name}>{name}</option>)}</select>
      <button className="btn server-incomplete-filter" aria-pressed={incompleteOnly} onClick={() => { setIncompleteOnly(current => !current); setPage(0) }}>待完善 <span>{incompleteCount}</span></button>
    </div>
    <div className="server-bulk"><strong>已选 {picked.length} 台</strong><button className="btn btn-sm" disabled={!picked.length || picked.length > 12} title="一次最多打开 12 个会话" onClick={() => picked.forEach(connection => open(connection))}>打开所选</button><button className="btn btn-sm" disabled={!picked.length} onClick={() => setTesting(true)}>测试公共凭据</button><button className="btn btn-sm" disabled={!picked.length} onClick={() => useApp.setState({ monitorBatchConnectionIds: picked.map(item => item.id) })}>批量安装采集端</button><button className="btn btn-sm" disabled={!picked.length || picked.length > 1000} onClick={() => setBatch(picked)}>批量编辑</button>{picked.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>取消选择</button>}</div>
    {message && <div role="status" className="field-hint">{message}</div>}
    <div className="server-health-toolbar"><div><strong><span className="server-health-dot" />本页 {reachable} 台端口可达</strong><span>{unreachable} 台不可达 · 每轮完成后 30 秒刷新</span><small>这里只检查端口与 TCP 建连延迟；系统资源请在 SSH 终端右侧查看，不额外登录服务器。</small></div><button className="btn btn-ghost btn-sm" aria-pressed={monitoring.enabled} onClick={() => monitoring.setEnabled(current => !current)}>{monitoring.enabled ? '暂停自动监测' : '开启自动监测'}</button><button className="btn btn-sm" disabled={monitoring.checking || !monitoring.enabled} onClick={monitoring.refresh}><Icon name="refresh" size={14} />{monitoring.checking ? '检测中…' : '刷新状态'}</button></div>
    <div className="server-table-wrap"><table className="table server-table"><thead><tr><th><input aria-label="选择当前页" type="checkbox" checked={visible.length > 0 && visible.every(item => selected.has(item.id))} onChange={event => { const checked = event.target.checked; setSelected(current => { const next = new Set(current); for (const item of visible) { if (checked) next.add(item.id); else next.delete(item.id) } return next }) }} /></th><th>服务器 / 账号</th><th>连接状态 / 延迟</th><th>分组 / 标签</th><th>备注</th><th>会话</th><th>操作</th></tr></thead><tbody>{visible.map(connection => {
      const live = tabs.filter(tab => tab.connectionId === connection.id && (tab.kind === 'ssh' || tab.kind === 'rdp'))
      const session = sessions.find(item => item.connectionId === connection.id && item.kind === 'ssh' && item.status === 'connected')
      return <tr key={connection.id}><td><input type="checkbox" aria-label={`选择 ${connection.name}`} checked={selected.has(connection.id)} onChange={() => toggle(connection.id)} /></td><td><div className="server-name-row"><button className="server-name" onClick={() => open(connection)}>{connection.name}</button><ConnectionCheckBadge connectionId={connection.id} onEdit={() => onEdit(connection.id)} /></div><div className="mono server-address">{connection.kind.toUpperCase()} · {connection.username && connection.username + '@'}{formatConnectionAddress(connection.host, connection.port)}</div></td><td><ServerHealthCell health={monitoring.health[connection.id]} connected={!!session} /></td><td><div>{connection.group || '未分组'}</div><div className="server-tags">{connection.tags?.map(tag => <TagPill tag={tag} key={tag} />)}</div></td><td className="server-note" title={connection.note}>{connection.note || <span className="muted">—</span>}</td><td>{live.length ? <button className="btn btn-ghost btn-sm" onClick={() => useApp.getState().setActiveTab(live[0]!.id)}>{live.length} 个会话</button> : '—'}</td><td><div className="server-actions"><button className="btn btn-sm" onClick={() => open(connection, true)}>新会话</button><button className="btn btn-ghost btn-sm" onClick={() => onEdit(connection.id)}>编辑</button></div></td></tr>
    })}</tbody></table>{!visible.length && <div className="empty server-empty">{connections.length ? '没有匹配的服务器，试试调整搜索或筛选条件。' : <><strong>还没有服务器，先添加一台吧</strong><span>新建 SSH / RDP 连接，或从 XTerminal、RDO 迁移已有配置。</span><div><button className="btn btn-primary" onClick={onNew}>新建连接</button><button className="btn" onClick={onImport}>导入连接</button></div></>}</div>}</div>
    <div className="server-pagination"><span>找到 {matched.length} 台 · 每页 50 台</span><button className="btn btn-sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {lastPage + 1}</span><button className="btn btn-sm" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>下一页</button></div>
    {batch && <BatchMetadataEditor connections={batch} onClose={() => setBatch(null)} onSaved={count => { setBatch(null); setSelected(new Set()); setMessage(`已更新 ${count} 台服务器的标签、备注或分组。`) }} />}
    {testing && <CredentialTest connectionIds={picked.map(item => item.id)} onClose={() => setTesting(false)} />}
  </div>
}
