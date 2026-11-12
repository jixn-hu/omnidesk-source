import { normalizeAppearance, useAppearance } from './store/appearance'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useApp } from './store/app'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import StatusBar from './components/StatusBar'
import VaultGate from './components/VaultGate'
import HostKeyDialog from './components/HostKeyDialog'
import ApprovalToasts from './components/ApprovalToasts'
import ConnectionEditor from './features/connections/ConnectionEditor'
import ImportDialog from './features/import/ImportDialog'
import TerminalView from './features/terminal/TerminalView'
import DesktopView from './features/desktop/DesktopView'
import FilesView from './features/files/FilesView'
import MonitorDashboard from './features/monitor/MonitorDashboard'
import MonitorAgentDialog from './features/monitor/MonitorAgentDialog'
import MonitorBatchInstallDialog from './features/monitor/MonitorBatchInstallDialog'
import ForwardsView from './features/forwards/ForwardsView'
import ExternalView from './features/external/ExternalView'
import SettingsView from './features/settings/SettingsView'
import AiView from './features/ai/AiView'
import './styles/ai.css'
import CredentialsView from './features/credentials/CredentialsView'
import Icon from './components/Icon'
import ServersView from './features/connections/ServersView'
import AccountView from './features/account/AccountView'
import SharedServersView from './features/account/SharedServersView'
import { SoftwareUpdateNotice } from './features/settings/SoftwareUpdates'
import QuickStartGuide from './components/QuickStartGuide'
import './styles/app.css'
import './styles/workspace.css'
import './styles/management.css'
import './styles/account.css'

const SharedSessionView = lazy(() => import('./features/account/SharedSessionView'))

export default function App() {
  useEffect(()=>window.omnidesk.account.onChanged(status=>useApp.getState().setAccountStatus(status)),[])
  useEffect(() => window.omnidesk.configuration.onRestored(summary => {
    void window.omnidesk.connections.list().then(result => { if (result.ok) useApp.getState().setConnections(result.data) })
    if (summary.preferences) {
      useAppearance.getState().setPreferences(normalizeAppearance(summary.preferences.appearance))
      localStorage.setItem('omnidesk.monitor.view', summary.preferences.monitorView)
    }
    window.dispatchEvent(new Event('omnidesk:monitoring-changed'))
    window.dispatchEvent(new CustomEvent('omnidesk:backup-restored', { detail: summary.sections ?? [] }))
  }), [])

  const accountScope=useApp(s=>s.accountServerUrl+'|'+(s.accountUser?.id??'local'))
  const monitorInstallConnectionId = useApp(state => state.monitorInstallConnectionId)
  const monitorBatchConnectionIds = useApp(state => state.monitorBatchConnectionIds)
  const [ready, setReady] = useState(false)
  const vaultStatus = useApp((s) => s.vaultStatus)
  const setVaultStatus = useApp((s) => s.setVaultStatus)
  const setConnections = useApp((s) => s.setConnections)
  const connections = useApp((s) => s.connections)
  const setSessions = useApp((s) => s.setSessions)
  const setExternalConfig = useApp((s) => s.setExternalConfig)
  const setHostKeyRequest = useApp((s) => s.setHostKeyRequest)
  const pushApproval = useApp((s) => s.pushApproval)
  const tabs = useApp((s) => s.tabs)
  const activeTabId = useApp((s) => s.activeTabId)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [newKind, setNewKind] = useState<'ssh' | 'rdp'>('ssh')

  const newConnection = (kind: 'ssh' | 'rdp' = 'ssh') => { setNewKind(kind); setEditingId(null); setEditorOpen(true) }

  useEffect(() => {
    let active = true
    let request = 0
    const refresh = async () => {
      const current = ++request
      const result = await window.omnidesk.connections.checks()
      if (active && current === request) useApp.setState({ connectionChecks: result.ok ? result.data : {} })
    }
    void refresh()
    const unsubscribe = window.omnidesk.connections.onChecksChanged(() => void refresh())
    window.addEventListener('focus', refresh)
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', refresh) }
  }, [connections, vaultStatus])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'n') return
      if (editorOpen || importOpen || document.querySelector('[aria-modal="true"]')) return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]') && !(event.shiftKey && target.closest('.terminal-workspace'))) return
      if (target.closest('.terminal-workspace, .desktop-workspace') && !event.shiftKey) return
      event.preventDefault()
      setNewKind('ssh')
      setEditingId(null)
      setEditorOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editorOpen, importOpen])

  /* 初始化：读状态 + 注册事件订阅 */
  useEffect(() => {
    const api = window.omnidesk

    void (async () => {
      const status = await api.vault.status()
      let effective = status.ok ? status.data : 'uninitialized'

      // 已建保险箱但处于锁定态时，先试一次免密码解锁。
      // 「设备密钥」模式下这一步会成功，用户完全看不到解锁界面。
      if (effective === 'locked') {
        const auto = await api.vault.autoUnlock()
        if (auto.ok && auto.data) {
          effective = 'unlocked'
        }
      }
      setVaultStatus(effective as typeof vaultStatus)

      // 未解锁时不读连接列表 —— 那时凭据读不出来，读了也没意义
      if (effective === 'unlocked') {
        const conns = await api.connections.list()
        if (conns.ok) setConnections(conns.data)
      }

      const sessions = await api.ssh.list()
      if (sessions.ok) setSessions(sessions.data)

      const ext = await api.external.config()
      if (ext.ok) setExternalConfig(ext.data)

      setReady(true)
    })()

    const unsubs = [
      api.ai.onMetadataChanged(() => { void api.connections.list().then(result => { if (result.ok) setConnections(result.data) }) }),
      api.ssh.onSessionEvent((info) => {
        useApp.setState((s) => {
          const idx = s.sessions.findIndex((x) => x.id === info.id)
          const next = idx >= 0 ? s.sessions.map((x) => (x.id === info.id ? info : x)) : [...s.sessions, info]
          const pending = [s.hostKeyRequest, ...s.hostKeyQueue].filter((request): request is NonNullable<typeof request> => !!request && !(request.sessionId === info.id && info.status !== 'connecting'))
          return { sessions: next, hostKeyRequest: pending[0] ?? null, hostKeyQueue: pending.slice(1) }
        })
      }),
      api.ssh.onHostKeyPrompt((p) => setHostKeyRequest(p)),
      api.external.onApprovalRequest((p) => pushApproval(p))
    ]

    return () => unsubs.forEach((u) => u())
  }, [setVaultStatus, setConnections, setSessions, setExternalConfig, setHostKeyRequest, pushApproval])

  useEffect(() => {
    if (vaultStatus !== 'unlocked') { useApp.setState({ monitoringVisible: false }); return }
    let alive = true, revision = 0
    const refreshMonitoring = async () => {
      const request = ++revision
      try {
        const result = await window.omnidesk.monitoring.local()
        if (!alive || request !== revision) return
        const visible = result.ok && result.data.config.enabled && !!result.data.config.url.trim()
        useApp.setState(state => ({ monitoringVisible: visible, ...(!visible ? {
          tabs: state.tabs.filter(tab => tab.kind !== 'monitoring'),
          activeTabId: state.tabs.some(tab => tab.id === state.activeTabId && tab.kind === 'monitoring') ? null : state.activeTabId
        } : {}) }))
      } catch { if (alive && request === revision) useApp.setState({ monitoringVisible: false }) }
    }
    void refreshMonitoring()
    window.addEventListener('omnidesk:monitoring-changed', refreshMonitoring)
    return () => { alive = false; window.removeEventListener('omnidesk:monitoring-changed', refreshMonitoring) }
  }, [vaultStatus])

  /* 保险箱未解锁时，先走解锁流程 */
  if (!ready) {
    return <div className="boot-splash">正在启动…</div>
  }

  if (vaultStatus !== 'unlocked') {
    return <VaultGate />
  }

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const sessionActive = activeTab?.kind === 'ssh' || activeTab?.kind === 'rdp' || activeTab?.kind === 'shared-session'

  return (
    <div className="app-shell">
      <Sidebar
        onEdit={(id) => {
          setEditingId(id)
          setEditorOpen(true)
        }}
      />

      <div className="main-area" data-session={sessionActive}>
        <header className="workspace-header" data-session={sessionActive}>
          <div className="workspace-breadcrumb"><button className="btn btn-ghost btn-icon" title="返回工作台" aria-label="返回工作台" onClick={() => useApp.setState({ activeTabId: null })}><Icon name="home" size={17} /></button>{!sessionActive && <><span>/</span><strong>{activeTab?.title ?? '工作台'}</strong></>}</div>
          <div id="session-toolbar-slot" className="workspace-session-slot" hidden={!sessionActive} />
          {!sessionActive && <div className="workspace-header-actions"><span className="workspace-local"><span className="dot dot-connected" />本地工作空间</span><button className="btn btn-primary btn-sm" onClick={() => newConnection()}><Icon name="plus" size={15} />新建连接</button></div>}
        </header>
        <TabBar />

        <div className="content-area">
          {!activeTab && (
            <WelcomePanel
              onNew={newConnection}
            />
          )}
          {tabs.filter((tab) => tab.kind === 'ssh' || tab.kind === 'rdp' || tab.kind === 'shared-session').map((tab) => <div className="session-panel" key={tab.id} hidden={tab.id !== activeTabId} aria-hidden={tab.id !== activeTabId}>
            {tab.kind === 'shared-session' ? <Suspense fallback={null}><SharedSessionView tab={tab} active={tab.id === activeTabId} /></Suspense> : tab.kind === 'ssh' ? <TerminalView tab={tab} active={tab.id === activeTabId} /> : <DesktopView tab={tab} active={tab.id === activeTabId} />}
          </div>)}
          {activeTab?.kind === 'files' && <FilesView key={activeTab.id} tab={activeTab} />}
          {activeTab?.kind === 'monitoring' && <MonitorDashboard key={accountScope} initialNodeId={activeTab.monitorNodeId} />}
          {activeTab?.kind === 'forwards' && <ForwardsView key={activeTab.id} tab={activeTab} />}
          {activeTab?.kind === 'external' && <ExternalView />}
          {activeTab?.kind === 'settings' && <SettingsView />}
          {activeTab?.kind === 'ai' && <AiView />}
          {tabs.filter(tab => tab.kind === 'servers').map(tab => <div className="session-panel" key={tab.id} hidden={tab.id !== activeTabId}><ServersView active={tab.id === activeTabId} onNew={() => newConnection()} onImport={() => setImportOpen(true)} onEdit={id => { setEditingId(id); setEditorOpen(true) }} /></div>)}
          {activeTab?.kind === 'credentials' && <CredentialsView />}
          {activeTab?.kind === 'account' && <AccountView />}
          {activeTab?.kind === 'shared-servers' && <SharedServersView key={accountScope} />}
        </div>

        <StatusBar />
      </div>

      {editorOpen && (
        <ConnectionEditor
          connectionId={editingId}
          initialKind={newKind}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}

      {monitorBatchConnectionIds && <MonitorBatchInstallDialog key={accountScope} connectionIds={monitorBatchConnectionIds} onClose={() => useApp.setState({ monitorBatchConnectionIds: null })} />}
      {monitorInstallConnectionId && <MonitorAgentDialog key={accountScope + '|' + monitorInstallConnectionId} connectionId={monitorInstallConnectionId}
        onClose={() => useApp.setState({ monitorInstallConnectionId: null })}
        onChanged={() => window.dispatchEvent(new Event('omnidesk:monitor-nodes-changed'))} />}
      <HostKeyDialog />
      <ApprovalToasts />
      <SoftwareUpdateNotice />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function WelcomePanel({ onNew }: { onNew: (kind?: 'ssh' | 'rdp') => void }) {
  const connections = useApp((s) => s.connections)
  const openTab = useApp((s) => s.openTab)

  const sessions = useApp((state) => state.sessions)
  const tabs = useApp((state) => state.tabs)
  const directories = (['ssh', 'rdp'] as const).map(kind => ({ kind, label: kind === 'ssh' ? 'SSH 终端' : 'RDP 桌面', connections: connections.filter(item => item.kind === kind).sort((first, second) => second.updatedAt - first.updatedAt) })).filter(directory => directory.connections.length > 0)
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem('omnidesk.home.collapsed') ?? '[]'); return Array.isArray(saved) ? saved.filter((value): value is string => value === 'ssh' || value === 'rdp') : [] } catch { return [] }
  })
  const toggleDirectory = (kind: string) => setCollapsed(current => { const next = current.includes(kind) ? current.filter(item => item !== kind) : [...current, kind]; localStorage.setItem('omnidesk.home.collapsed', JSON.stringify(next)); return next })
  const connected = sessions.filter((session) => session.status === 'connected').length + tabs.filter((tab) => tab.kind === 'rdp' && tab.status === 'connected').length
  const [showGuide, setShowGuide] = useState(() => {
    const saved = localStorage.getItem('omnidesk.quick-start')
    return saved ? saved === 'visible' : connections.length === 0
  })
  useEffect(() => { localStorage.setItem('omnidesk.quick-start', showGuide ? 'visible' : 'hidden') }, [showGuide])
  const toggleGuide = (visible: boolean) => { setShowGuide(visible); localStorage.setItem('omnidesk.quick-start', visible ? 'visible' : 'hidden') }
  const openManager = () => openTab({ id: 'tab-servers', kind: 'servers', title: '服务器管理', status: 'idle' })

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="eyebrow">YOUR REMOTE WORKSPACE</div>
        <div className="welcome-heading"><div><h1 className="welcome-title">{connections.length ? '远程工作，尽在掌握。' : '连接你的第一台服务器。'}</h1>
          <p className="welcome-sub">{connections.length ? '终端、桌面与凭据，一个井然有序的工作空间。' : '不必注册账号，准备好地址和凭据，就能开始远程工作。'}</p></div><div className="welcome-brand-mark"><Icon name="layers" size={42} /></div></div>
        {!showGuide && <div className="welcome-guide-toggle"><button className="text-link" aria-expanded={false} onClick={() => toggleGuide(true)}><Icon name="info" size={14} />快速上手</button></div>}
        {showGuide && <QuickStartGuide onNew={onNew} onManage={openManager} onDismiss={() => toggleGuide(false)} />}
        {connections.length > 0 && <div className="workspace-stats">
          <div><span className="stat-icon"><Icon name="server" size={20} /></span><div><strong>{connections.length.toString().padStart(2, '0')}</strong><span>全部连接</span></div></div>
          <div><span className="stat-icon"><Icon name="terminal" size={20} /></span><div><strong>{connections.filter((connection) => connection.kind === 'ssh').length.toString().padStart(2, '0')}</strong><span>SSH 终端</span></div></div>
          <div><span className="stat-icon"><Icon name="monitor" size={20} /></span><div><strong>{connections.filter((connection) => connection.kind === 'rdp').length.toString().padStart(2, '0')}</strong><span>远程桌面</span></div></div>
          <div><span className="stat-icon is-live"><Icon name="link" size={20} /></span><div><strong>{connected.toString().padStart(2, '0')}</strong><span>活跃会话</span></div></div>
        </div>}
        {(!showGuide || connections.length > 0) && <div className="welcome-columns"><section className="welcome-connections"><div className="section-heading"><h2>连接工作区 <span>{connections.length}</span></h2><button className="text-link" onClick={() => onNew()}>添加连接 <Icon name="plus" size={14} /></button></div>

        {directories.length > 0 ? (
          <div className="welcome-list">
            {directories.map(directory => <section className="welcome-directory" key={directory.kind} aria-label={directory.label}>
              <button className="welcome-directory-heading" aria-expanded={!collapsed.includes(directory.kind)} aria-controls={`home-directory-${directory.kind}`} onClick={() => toggleDirectory(directory.kind)}><Icon name="folder" size={18} /><strong>{directory.label}</strong><span>{directory.connections.length}</span><Icon name="chevron" size={15} /></button>
              <div id={`home-directory-${directory.kind}`} hidden={collapsed.includes(directory.kind)}>{directory.connections.map((c) => (
              <button
                key={c.id}
                className="welcome-connection-row"
                onClick={() =>
                  openTab({
                    kind: c.kind === 'rdp' ? 'rdp' : 'ssh',
                    title: c.name,
                    connectionId: c.id,
                    status: 'idle'
                  })
                }
              >
                <span className={`connection-symbol ${c.kind}`}><Icon name={c.kind === 'ssh' ? 'terminal' : 'monitor'} size={19} /></span>
                <span className="welcome-connection-detail"><strong>{c.name}</strong><span className="mono">{c.sharedCredentialId ? '共享账号 · ' : `${c.username}@`}{c.host}:{c.port}</span></span>
                <span className="connection-group">{c.group || '未分组'}</span><span className={`welcome-card-kind ${c.kind}`}>{c.kind.toUpperCase()}</span><Icon name="arrow" size={16} />
              </button>
            ))}</div></section>)}
          </div>
        ) : (
          <div className="welcome-empty">
            <div className="feature-icon"><Icon name="server" size={28} /></div><h2>从第一台服务器开始</h2><p>添加 SSH 或 RDP 连接，或迁移已有的主机配置。</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={() => onNew()}>
                新建连接
              </button>
              <button className="btn" onClick={openManager}>
                服务器管理 / 导入
              </button>
            </div>
          </div>
        )}
        </section><aside className="welcome-utilities"><div className="section-heading"><h2>工作台工具</h2></div>
          <button className="utility-card" onClick={() => openTab({ id: 'tab-credentials', kind: 'credentials', title: '公共凭据', status: 'idle' })}><span className="utility-icon"><Icon name="key" size={21} /></span><strong>公共凭据</strong><p>账号与密钥集中维护，多台服务器安全复用。</p><span className="text-link">管理凭据 <Icon name="arrow" size={14} /></span></button>
          <button className="utility-card" onClick={openManager}><span className="utility-icon"><Icon name="server" size={21} /></span><strong>服务器管理</strong><p>搜索、分组与批量操作。也可在这里导入 XTerminal / RDO 连接。</p><span className="text-link">管理服务器 <Icon name="arrow" size={14} /></span></button>
        </aside></div>}
        <div className="welcome-hints"><span><Icon name="shield" size={14} />凭据本机加密 · 连接独立代理</span><span><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> 搜索连接</span></div>
      </div>
    </div>
  )
}
