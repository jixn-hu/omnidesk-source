import ActionButton from '../../components/ActionButton'
import { useEffect, useRef, useState } from 'react'
import type { MonitorInstallStage, MonitorInstallResult, MonitorWindowsCommand, MonitorNode, MonitorAgentBinding } from '@shared/monitoring'
import type { IpcResult } from '@shared/types'
import { useApp } from '../../store/app'
import { monitorInstallTarget } from './monitor-install-target'

const stages: Record<MonitorInstallStage, string> = { connecting: '正在准备安装…', checking: '正在检查安装环境…', uploading: '正在上传采集程序和配置…', installing: '正在安装并启动服务…', reporting: '正在等待首次上报…' }
const unwrap = <T,>(result: IpcResult<T>): T => { if (!result.ok) throw new Error(result.message); return result.data }

export default function MonitorAgentInstall({ nodeId: initialNodeId, initialNode, defaultConnectionId, onBusyChange, onChanged }: { nodeId?: string; initialNode?: MonitorNode; defaultConnectionId?: string; onBusyChange?: (busy: boolean) => void; onChanged?: () => void }) {
  const connections = useApp(state => state.connections), sessions = useApp(state => state.sessions)
  const servers = connections.filter(server => server.kind === 'ssh' || server.kind === 'rdp')
  const targetTouched = useRef(false)
  const account = useApp(state => state.accountUser), serverUrl = useApp(state => state.accountServerUrl)
  const [infoRevision, setInfoRevision] = useState(0)
  const [nodeId, setNodeId] = useState(initialNodeId)
  const busyRef = useRef(false), alive = useRef(true), operation = useRef(0), nodeRef = useRef(initialNodeId)
  const callbacks = useRef({ onBusyChange, onChanged }); callbacks.current = { onBusyChange, onChanged }
  const [connectionId, setConnectionId] = useState(defaultConnectionId ?? monitorInstallTarget(initialNode, connections) ?? ''), [hasToken, setHasToken] = useState<boolean>(), [renew, setRenew] = useState(false)
  const [busy, setBusy] = useState(false), [stage, setStage] = useState<MonitorInstallStage>(), [error, setError] = useState('')
  const [result, setResult] = useState<MonitorInstallResult>(), [command, setCommand] = useState<MonitorWindowsCommand>()
  const [watch, setWatch] = useState<{ nodeId: string; installationId: string; until: number }>()
  const [now, setNow] = useState(Date.now()), [copied, setCopied] = useState(false)
  const [installMode, setInstallMode] = useState<'auto' | 'user'>('auto'), [sudoPassword, setSudoPassword] = useState(''), [sudoRequired, setSudoRequired] = useState(false)
  useEffect(() => { setSudoPassword(''); setSudoRequired(false); setInstallMode('auto') }, [connectionId, serverUrl, account?.username])
  const windows = servers.find(server => server.id === connectionId)?.kind === 'rdp'
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++ } }, [])
  useEffect(() => {
    if (!nodeId) return
    let cancelled = false
    window.omnidesk.monitoring.agentInstallInfo(nodeId).then(value => {
      if (cancelled) return
      if (value.ok) { setHasToken(value.data.hasToken); if (!defaultConnectionId && !targetTouched.current) setConnectionId(current => servers.some(server => server.id === value.data.connectionId) ? value.data.connectionId! : current || monitorInstallTarget(initialNode, connections) || '') }
      else setError(value.message)
    }).catch(() => { if (!cancelled) setError('读取安装信息失败，请重新打开此页面') })
    return () => { cancelled = true }
  }, [nodeId, infoRevision, connections])
  useEffect(() => window.omnidesk.monitoring.onAgentInstallProgress(value => {
    if (value.nodeId === nodeRef.current && value.connectionId === connectionId) setStage(value.stage)
  }), [connectionId])
  useEffect(() => {
    if (!watch) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const check = async () => {
      const response = await window.omnidesk.monitoring.nodes().catch(() => undefined)
      if (cancelled) return
      setNow(Date.now())
      const node = response?.ok ? response.data.find(item => item.id === watch.nodeId) : undefined
      if (node?.lastSeen && node.metrics?.installationId === watch.installationId) {
        const installed = { active: true, reported: true, message: '本次安装的采集端已成功上报，已接入监控。' }
        setResult(installed); setWatch(undefined)
        callbacks.current.onChanged?.(); window.dispatchEvent(new CustomEvent('omnidesk:monitor-nodes-changed', { detail: { connectionId, nodeId: watch.nodeId, result: installed } }))
      } else if (Date.now() >= watch.until) {
        setWatch(undefined); setResult({ active: false, reported: false, message: '暂未收到本次安装的首次上报。请确认已在目标 Windows 以管理员运行，并检查 OmniDeskMonitor 服务、网络和证书；可稍后刷新监控。' })
      } else timer = setTimeout(check, 2500)
    }
    void check()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [watch])
  const install = async (manual = false, replaceBinding?: MonitorAgentBinding) => {
    if (!account || !connectionId || busyRef.current || nodeId && (hasToken === undefined || !hasToken && !renew)) return
    const password = sudoPassword; setSudoPassword('')
    const revision = ++operation.current
    const current = () => alive.current && revision === operation.current
    busyRef.current = true
    setBusy(true); onBusyChange?.(true); setError(''); setResult(undefined); setCommand(undefined); setWatch(undefined); setCopied(false); setStage('connecting')
    try {
      const local = unwrap(await window.omnidesk.monitoring.local()); if (!current()) return
      if (!local.config.enabled) {
        unwrap(await window.omnidesk.monitoring.configure({ enabled: true })); if (!current()) return
        window.dispatchEvent(new Event('omnidesk:monitoring-changed'))
      }
      let targetNodeId = nodeId, replaceToken = hasToken === false && renew
      if (!targetNodeId) {
        const prepared = unwrap(await window.omnidesk.monitoring.prepareAgentNode(connectionId)); if (!current()) return
        targetNodeId = prepared.id; nodeRef.current = targetNodeId; setNodeId(targetNodeId); onChanged?.()
        const info = unwrap(await window.omnidesk.monitoring.agentInstallInfo(targetNodeId)); if (!current()) return
        setHasToken(info.hasToken)
        if (!info.hasToken) throw new Error('此服务器已有监控节点，本机没有采集令牌，请确认更换令牌后安装。')
        replaceToken = false
      }
      const input = { nodeId: targetNodeId, connectionId, renewToken: replaceToken, ...(replaceBinding ? { replaceBinding } : {}) }
      if (windows) {
        let installationId: string | undefined
        if (manual) {
          const exported = unwrap(await window.omnidesk.monitoring.exportWindowsInstaller(input)); if (!current() || exported.cancelled) return
          installationId = exported.installationId
          setResult({ active: false, reported: false, message: `已保存：${exported.path}。复制到目标 Windows，在管理员 PowerShell 执行 powershell -NoProfile -ExecutionPolicy Bypass -File .\\OmniDesk-Monitor-Install.ps1。等待首次上报；安装后删除含节点凭据的脚本。` })
        } else {
          const generated = unwrap(await window.omnidesk.monitoring.windowsInstallCommand(input)); if (!current()) return
          installationId = generated.installationId; setCommand(generated); setNow(Date.now())
          setResult({ active: false, reported: false, message: '新命令已生成。请在目标 Windows 的管理员 PowerShell 运行，正在等待本次安装的首次上报…' })
          try {
            await navigator.clipboard.writeText(generated.command); if (!current()) return
            setCopied(true); setResult({ active: false, reported: false, message: '新命令已生成并复制。请在目标 Windows 的管理员 PowerShell 运行，正在等待本次安装的首次上报…' })
          } catch { if (current()) setError('新命令已生成，但复制失败。请点击「复制安装命令」或手动复制上方新命令。') }
          if (!current()) return
        }
        if (installationId) setWatch({ nodeId: targetNodeId, installationId, until: Date.now() + 20 * 60 * 1000 })
        onChanged?.()
      } else {
        const installed = unwrap(await window.omnidesk.monitoring.installAgent({ ...input, installMode, ...(password ? { sudoPassword: password } : {}) })); if (!current()) return
        setResult(installed); if (installed.needsSudoPassword) setSudoRequired(true); onChanged?.(); window.dispatchEvent(new CustomEvent('omnidesk:monitor-nodes-changed', { detail: { connectionId, nodeId: targetNodeId, result: installed } }))
      }
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : '安装请求失败，请检查连接后重试') }
    finally {
      if (current()) {
        const info = nodeRef.current ? await window.omnidesk.monitoring.agentInstallInfo(nodeRef.current).catch(() => undefined) : undefined
        if (current()) { if (info?.ok) { setHasToken(info.data.hasToken); if (info.data.hasToken) setRenew(false) }; busyRef.current = false; setBusy(false); onBusyChange?.(false) }
      }
    }
  }
  const copyCommand = async () => {
    if (!command) return
    const revision = operation.current
    const current = () => alive.current && revision === operation.current
    setCopied(false)
    try { await navigator.clipboard.writeText(command.command); if (current()) { setCopied(true); setError('') } }
    catch { if (current()) setError('复制失败，请手动选中上方命令复制') }
  }
  const disabled = (!windows && installMode === 'auto' && sudoRequired && !sudoPassword) || busy || !!result?.reported || !account || !connectionId || !!nodeId && (hasToken === undefined || !hasToken && !renew)
  return <div className="monitor-agent-install">
    <p className="field-hint">{initialNode ? `监控节点：${initialNode.name}。请选择实际安装的服务器，同一绑定重装会保留累计流量。` : '选择服务器：Linux 通过 SSH 安装，Windows 复制一条命令安装。'}</p>
    <dl className="monitor-install-account"><div><dt>上报服务</dt><dd>{serverUrl || '请先配置账号服务'}</dd></div><div><dt>账号</dt><dd>{account?.username || '请先登录账号'}</dd></div></dl>
    {!account && <button className="btn btn-sm" onClick={() => useApp.getState().openTab({ kind: 'account', title: '账号', status: 'idle' })}>前往账号登录</button>}
    <label className="field">目标服务器<select aria-label="采集端目标服务器" value={connectionId} disabled={busy} onChange={event => {
      targetTouched.current = true; operation.current++; setConnectionId(event.target.value); setResult(undefined); setError(''); setCommand(undefined); setWatch(undefined); setCopied(false); setRenew(false)
      if (!initialNodeId) { setNodeId(undefined); nodeRef.current = undefined; setHasToken(undefined) }
    }}><option value="">请选择已保存的 SSH 或 RDP 连接</option>{servers.map(server => <option key={server.id} value={server.id}>{server.name} · {server.host}{sessions.some(session => session.connectionId === server.id && session.status === 'connected') ? ' · 已连接' : ''}</option>)}</select></label>
    {!connectionId && !!servers.length && <p className="field-hint">尚未找到唯一对应的本地连接，请选择实际目标服务器；系统不会自动选择其他机器。</p>}
    {!servers.length && <p className="field-hint">请先保存一个 SSH 或 Windows RDP 连接。</p>}
    {!nodeId && <p className="field-hint">沿用连接名称和分组，重复安装会复用已绑定的监控节点。</p>}
    <p className="field-hint">{!connectionId ? '选择 SSH 连接后将自动检查 Linux 安装环境；选择 RDP 连接后生成 Windows 安装命令。' : windows ? '首次需在目标 Windows x64 的管理员 PowerShell 运行命令，安装后自动后台运行，无需保持 RDP 连接。支持重复覆盖安装；若已有其他节点或后端绑定，脚本会显示旧、新绑定，输入 Y 后覆盖。也可导出完整脚本手动安装。' : 'Linux 通过 SSH 自动安装：优先使用系统服务；sudo 需要密码时会提示输入，没有提权权限时尝试用户级安装。用户级安装的开机启动取决于系统支持，安装结果会明确说明。其他节点或后端的覆盖仍需确认。'}</p>
    {connectionId && !windows && <label className="field">安装方式<select aria-label="Linux 安装方式" value={installMode} disabled={busy} onChange={event => { setInstallMode(event.target.value as 'auto' | 'user'); setSudoPassword(''); setSudoRequired(false); setResult(undefined); setError('') }}><option value="auto">自动选择（优先系统服务）</option><option value="user">以当前用户安装（无需 sudo）</option></select></label>}
    {!windows && installMode === 'auto' && sudoRequired && <label className="field">sudo 密码<input aria-label="sudo 密码" type="password" value={sudoPassword} autoComplete="off" maxLength={4096} disabled={busy} onChange={event => setSudoPassword(event.target.value)} /><small className="field-hint">用于本次安装提权，提交后清空，不会保存到连接配置。没有 sudo 权限可改选「以当前用户安装」。</small></label>}
    {connectionId && hasToken === false && <label className="monitor-agent-renew"><input type="checkbox" checked={renew} disabled={busy} onChange={event => setRenew(event.target.checked)} /><span>本机没有此节点的安装凭据，同意更新凭据并重新安装。安装检查通过后才会更新，旧凭据届时失效。</span></label>}
    {error && <p className="alert alert-danger" role="alert">{error}</p>}{error && nodeId && hasToken === undefined && !busy && <button className="btn btn-sm" onClick={() => { setError(''); setInfoRevision(value => value + 1) }}>重试读取安装信息</button>}
    {command && <div className="monitor-install-command"><label className="field">在目标 Windows 管理员 PowerShell 执行<textarea aria-label="Windows 安装命令" className="mono" readOnly rows={5} value={command.command} onFocus={event => event.target.select()} /></label><div className="monitor-agent-install-actions"><ActionButton phase={copied ? 'success' : 'idle'} icon="copy" successLabel="已复制" className="btn btn-sm" disabled={now >= command.expiresAt || !!result?.reported} onClick={() => void copyCommand()}>复制安装命令</ActionButton><small className="field-hint">{now >= command.expiresAt ? '命令已过期；已运行的安装仍会继续上报。' : `${new Date(command.expiresAt).toLocaleTimeString()} 前可重复下载和重试安装；生成新命令后旧命令失效。`}</small></div></div>}
    {result?.replacement && <div className="monitor-install-replacement" role="alert"><strong>确认覆盖已有监控</strong><dl><div><dt>当前后端</dt><dd>{result.replacement.serverUrl}</dd></div><div><dt>当前节点</dt><dd>{result.replacement.nodeName || result.replacement.nodeId}</dd></div><div><dt>安装到</dt><dd>{serverUrl} · {initialNode?.name || nodeId}</dd></div></dl><p>{result.message}</p></div>}
    {result && !result.replacement && <p className={result.reported ? 'alert alert-success' : 'alert alert-warning'} role="status">{result.message}</p>}
    <div className="monitor-agent-install-actions"><ActionButton phase={busy ? 'busy' : result?.reported ? 'success' : 'idle'} icon="import" className="btn btn-primary" disabled={disabled} onClick={() => void install(false, result?.replacement)}>{busy ? stages[stage ?? 'connecting'] : result?.replacement ? '确认覆盖并安装' : result?.reported ? '已接入监控' : sudoRequired && installMode === 'auto' ? '使用 sudo 密码安装' : windows ? '生成并复制新命令' : !nodeId ? '加入监控并安装' : hasToken === false ? '更换令牌并安装' : '安装采集端'}</ActionButton>{result?.replacement && <button className="btn" disabled={busy} onClick={() => { setResult(undefined); setError('') }}>取消覆盖</button>}{windows && <button className="btn" disabled={disabled} onClick={() => void install(true)}>导出手动安装脚本</button>}</div>
  </div>
}
