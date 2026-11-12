import { useEffect, useRef, useState } from 'react'
import type { MonitorInstallStage, MonitorInstallResult, MonitorWindowsCommand } from '@shared/monitoring'
import { formatConnectionAddress, matchesConnection } from '@shared/connection-identity'
import { useApp } from '../../store/app'
import { runMonitorBatch, type BatchInstallRow, type BatchInstallStatus } from './monitor-batch-install'
import './monitoring.css'

const labels: Record<BatchInstallStatus, string> = { queued: '排队中', preparing: '检查连接', installing: '安装中', reported: '已上报', started: '已启动 · 待上报', command: '待手动执行', attention: '需单独处理', failed: '安装失败', cancelled: '未开始' }
const stages: Record<MonitorInstallStage, string> = { connecting: '正在连接服务器…', checking: '正在检查安装环境…', uploading: '正在上传采集程序…', installing: '正在安装并启动服务…', reporting: '正在等待首次上报…' }
const retryable = (row: BatchInstallRow) => ['failed', 'attention', 'cancelled'].includes(row.status)
const scopeNow = () => { const state = useApp.getState(); return state.accountServerUrl + '|' + (state.accountUser?.id ?? '') }

export default function MonitorBatchInstallDialog({ connectionIds, onClose }: { connectionIds: string[]; onClose: () => void }) {
  const connections = useApp(state => state.connections)
  const account = useApp(state => state.accountUser), serverUrl = useApp(state => state.accountServerUrl)
  const servers = connections.filter(item => item.kind === 'ssh' || item.kind === 'rdp')
  const [selected, setSelected] = useState(() => new Set(connectionIds))
  const [query, setQuery] = useState(''), [group, setGroup] = useState('')
  const [mode, setMode] = useState<'auto' | 'user'>('auto')
  const [rows, setRows] = useState<BatchInstallRow[]>([]), [busy, setBusy] = useState(false), [stopping, setStopping] = useState(false)
  const [error, setError] = useState(''), [copied, setCopied] = useState(''), [now, setNow] = useState(Date.now())
  const alive = useRef(true), busyRef = useRef(false), stopped = useRef(false), scope = useRef(scopeNow())
  const isCurrent = () => alive.current && scope.current === scopeNow()
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopped.current = true } }, [])
  useEffect(() => window.omnidesk.monitoring.onAgentInstallProgress(progress => {
    if (isCurrent()) setRows(current => current.map(row => row.target.id === progress.connectionId && row.node?.id === progress.nodeId && row.status === 'installing' ? { ...row, message: stages[progress.stage] } : row))
  }), [])
  useEffect(() => {
    const completed = (event: Event) => {
      const { connectionId, nodeId, result } = (event as CustomEvent<{ connectionId: string; nodeId: string; result: MonitorInstallResult }>).detail ?? {}
      if (!connectionId || !nodeId || !result?.active || !isCurrent()) return
      setRows(current => current.map(row => row.target.id === connectionId && row.node?.id === nodeId && (retryable(row) || row.status === 'command')
        ? { ...row, status: result.reported ? 'reported' : 'started', message: result.message, command: undefined, watchUntil: undefined } : row))
    }
    window.addEventListener('omnidesk:monitor-nodes-changed', completed)
    return () => window.removeEventListener('omnidesk:monitor-nodes-changed', completed)
  }, [])
  const watchKey = rows.filter(row => row.status === 'command').map(row => row.target.id + ':' + row.command?.installationId).join('|')
  useEffect(() => {
    const watching = rows.filter(row => row.status === 'command' && row.command && row.node)
    if (!watching.length) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const check = async () => {
      if (cancelled || !isCurrent()) return
      const result = await window.omnidesk.monitoring.nodes().catch(() => undefined)
      if (cancelled || !isCurrent()) return
      const time = Date.now(); setNow(time)
      setRows(current => current.map(row => {
        if (row.status !== 'command' || !watching.some(item => item.target.id === row.target.id && item.command?.installationId === row.command?.installationId)) return row
        const node = result?.ok ? result.data.find(item => item.id === row.node?.id) : undefined
        if (node?.lastSeen && node.metrics?.installationId === row.command?.installationId) return { ...row, status: 'reported', command: undefined, message: '本次安装的采集端已成功上报。' }
        if (row.watchUntil && time >= row.watchUntil) return { ...row, status: 'attention', command: undefined, message: '暂未收到本次安装上报，请检查 Windows 服务与网络，或重新生成安装命令。' }
        return row
      }))
      timer = setTimeout(check, 5000)
    }
    void check()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [watchKey])
  const matched = servers.filter(item => matchesConnection(item, query) && (!group || (item.group || '未分组') === group))
  const picked = servers.filter(item => selected.has(item.id))
  const start = async (targets = picked, copyNewCommand = false) => {
    if (!account || !targets.length || busyRef.current || !isCurrent()) return
    busyRef.current = true; stopped.current = false; setBusy(true); setStopping(false); setError(''); setCopied('')
    const ids = new Set(targets.map(item => item.id))
    setRows(current => {
      const next = current.filter(row => !ids.has(row.target.id))
      return [...next, ...targets.map(target => ({ target, status: 'queued' as const, message: '等待安装…' }))]
    })
    const generated = new Map<string, MonitorWindowsCommand>()
    try {
      await runMonitorBatch(targets, { api: window.omnidesk.monitoring, installMode: mode, isCurrent, shouldStart: () => !stopped.current,
        update: (id, patch) => { if (patch.command) generated.set(id, patch.command); setRows(current => current.map(row => row.target.id === id ? { ...row, ...patch } : row)) } })
      const command = copyNewCommand && targets.length === 1 ? generated.get(targets[0]!.id) : undefined
      if (command && isCurrent()) {
        try { await navigator.clipboard.writeText(command.command); if (isCurrent()) setCopied(targets[0]!.id) }
        catch { if (isCurrent()) setError('新命令已生成，但复制失败。请点击「复制此机命令」或展开对应服务器的命令手动复制。') }
      }
    } catch { if (isCurrent()) setError('批量安装中断，请检查结果后重试未完成的服务器。') }
    finally {
      busyRef.current = false
      if (isCurrent()) { setBusy(false); window.dispatchEvent(new Event('omnidesk:monitoring-changed')); window.dispatchEvent(new Event('omnidesk:monitor-nodes-changed')) }
    }
  }
  const copy = async (row: BatchInstallRow) => {
    if (!row.command || row.command.expiresAt <= Date.now()) return
    try { await navigator.clipboard.writeText(row.command.command); if (isCurrent()) { setCopied(row.target.id); setError('') } }
    catch { if (isCurrent()) setError('复制失败，请展开此服务器的命令并手动复制。') }
  }
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const failures = rows.filter(retryable)
  const finished = rows.filter(row => ['reported', 'started', 'command', 'attention', 'failed', 'cancelled'].includes(row.status)).length
  return <div className="modal-overlay monitor-dialog-overlay" onClick={event => { if (event.target === event.currentTarget && !busyRef.current) onClose() }}>
    <section className="modal monitor-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="monitor-batch-title">
      <header className="modal-header"><h2 id="monitor-batch-title">批量安装监控采集端</h2><button className="btn btn-ghost btn-sm" aria-label="关闭批量安装" disabled={busy} onClick={onClose}>关闭</button></header>
      <div className="modal-body monitor-batch-body">
        <dl className="monitor-install-account"><div><dt>上报服务</dt><dd>{serverUrl || '请先配置账号服务'}</dd></div><div><dt>账号</dt><dd>{account?.username || '请先登录账号'}</dd></div></dl>
        {!account && <div className="alert" role="status">请先在「账号」登录要接收这些监控数据的服务。<button className="btn btn-sm" onClick={() => { onClose(); useApp.getState().openTab({ kind: 'account', title: '账号', status: 'idle' }) }}>前往登录</button></div>}
        <p className="field-hint">Linux 通过已保存的 SSH 登录信息与代理自动安装，最多同时处理 3 台。Windows 为每台服务器生成专属命令，需在对应机器的管理员 PowerShell 执行。首次上报后才显示「已上报」。重复安装复用已有绑定并保留累计流量；更换令牌或覆盖其他绑定需单独处理。</p>
        <label className="field monitor-batch-mode">Linux 安装方式<select aria-label="批量 Linux 安装方式" value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'auto' | 'user')}><option value="auto">自动选择（优先系统服务）</option><option value="user">以当前用户安装（无需 sudo）</option></select></label>
        {error && <div className="alert alert-danger" role="alert">{error}</div>}
        {!rows.length ? <>
          <div className="monitor-batch-filters"><input aria-label="搜索批量安装服务器" placeholder="搜索名称、地址、账号或标签" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="批量安装分组" value={group} onChange={event => setGroup(event.target.value)}><option value="">全部分组</option>{[...new Set(servers.map(item => item.group || '未分组'))].sort().map(name => <option key={name}>{name}</option>)}</select></div>
          <div className="monitor-batch-selection"><strong>已选 {picked.length} 台</strong><span>Linux {picked.filter(item => item.kind === 'ssh').length} · Windows {picked.filter(item => item.kind === 'rdp').length}</span><button className="btn btn-ghost btn-sm" disabled={!matched.length} onClick={() => setSelected(current => new Set([...current, ...matched.map(item => item.id)]))}>选择筛选结果</button><button className="btn btn-ghost btn-sm" disabled={!selected.size} onClick={() => setSelected(new Set())}>清空选择</button></div>
          <div className="monitor-batch-targets">{matched.map(target => <label className="monitor-batch-target" key={target.id}><input type="checkbox" checked={selected.has(target.id)} aria-label={'安装到 ' + target.name} onChange={() => toggle(target.id)} /><span><strong>{target.name}</strong><small>{target.kind.toUpperCase()} · {target.username && target.username + '@'}{formatConnectionAddress(target.host, target.port)}</small></span><small>{target.group || '未分组'}</small></label>)}{!matched.length && <p className="field-hint">{servers.length ? '没有匹配的服务器。' : '请先保存 SSH 或 Windows RDP 连接。'}</p>}</div>
        </> : <>
          <div className="monitor-batch-summary" role="status"><strong>已处理 {finished} / {rows.length}</strong><span>已上报 {rows.filter(row => row.status === 'reported').length} · 待手动执行 {rows.filter(row => row.status === 'command').length} · 待处理 {failures.length}</span></div>
          <progress className="monitor-batch-progress" aria-label="批量安装进度" value={finished} max={rows.length} />
          <div className="monitor-batch-results">{rows.map(row => <article className="monitor-batch-row" key={row.target.id} data-status={row.status}>
            <div className="monitor-batch-row-heading"><strong>{row.target.name}</strong><span className="monitor-batch-status">{labels[row.status]}</span></div>
            <small className="mono">{row.target.kind.toUpperCase()} · {formatConnectionAddress(row.target.host, row.target.port)}</small>
            <p>{row.message}</p>
            {(retryable(row) || row.status === 'command') && <div className="monitor-batch-row-actions">
              {row.command && <button className="btn btn-sm" disabled={row.command.expiresAt <= now} onClick={() => void copy(row)}>{row.command.expiresAt <= now ? '命令已过期' : copied === row.target.id ? '已复制' : '复制此机命令'}</button>}
              <button className="btn btn-sm" disabled={busy} onClick={() => void start([row.target], row.target.kind === 'rdp')}>{row.target.kind === 'rdp' ? '生成并复制新命令' : '重试'}</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => useApp.setState({ monitorInstallConnectionId: row.target.id })}>单独处理</button>
            </div>}
            {row.command && <details className="monitor-batch-command"><summary>查看此机命令 · 仅用于 {row.target.name}</summary><textarea className="mono" aria-label={row.target.name + ' 安装命令'} readOnly rows={4} value={row.command.command} /><p className="field-hint">{new Date(row.command.expiresAt).toLocaleTimeString()} 前可重复下载和重试安装；生成新命令后旧命令失效。</p></details>}
          </article>)}</div>
        </>}
      </div>
      <footer className="modal-footer monitor-batch-footer">{!rows.length ? <button className="btn btn-primary" disabled={!account || !picked.length || busy} onClick={() => void start()}>开始处理 {picked.length} 台</button> : <>
        {busy ? <><span className="field-hint">{stopping ? '已停止排队，等待正在安装的服务器完成。' : '正在安装，可停止尚未开始的任务。'}</span><button className="btn" disabled={stopping} onClick={() => { stopped.current = true; setStopping(true) }}>停止排队</button></> : <><button className="btn" onClick={() => { setRows([]); setError('') }}>重新选择</button>{failures.length > 0 && <button className="btn btn-primary" onClick={() => void start(failures.map(row => row.target))}>重试未完成 {failures.length} 台</button>}</>}
      </>}<button className="btn" disabled={busy} onClick={onClose}>完成</button></footer>
    </section>
  </div>
}
