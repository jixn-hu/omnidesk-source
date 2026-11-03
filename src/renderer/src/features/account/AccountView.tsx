import { useEffect, useState } from 'react'
import type { OfficialAccountStatus, OfficialAuthProviders } from '@shared/account'
import { useApp } from '../../store/app'
import Icon from '../../components/Icon'
import GitlabLogin from './GitlabLogin'

export default function AccountView() {
  const [status, setStatus] = useState<OfficialAccountStatus | null>(null)
  const [providers, setProviders] = useState<OfficialAuthProviders | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [action, setAction] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const userId = status?.user?.id

  useEffect(() => {
    let active = true
    void window.omnidesk.account.status().then(result => { if (active && result.ok) { setStatus(result.data); setServerUrl(result.data.serverUrl) } }).catch(() => { if (active) setError('读取账号状态失败') })
    return () => { active = false }
  }, [])
  useEffect(() => { if (status) useApp.setState({ accountUser: status.user }) }, [status])
  useEffect(() => {
    let active = true
    setProviders(null)
    if (status?.serverUrl) void window.omnidesk.account.providers().then(result => {
      if (active && result.ok) { setProviders(result.data); if (!result.data.registrationOpen) setAction('login') }
    }).catch(() => {})
    return () => { active = false }
  }, [status?.serverUrl, userId])

  const operate = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally {
      try { const result = await window.omnidesk.account.status(); if (result.ok) setStatus(result.data) } catch {}
      setBusy(false)
    }
  }
  const configure = async () => {
    const result = await window.omnidesk.account.configure(serverUrl)
    if (!result.ok) throw new Error(result.message)
    setStatus(result.data); setServerUrl(result.data.serverUrl)
  }
  const authenticate = () => operate(async () => {
    await configure()
    const result = await window.omnidesk.account.authenticate(action, username, password)
    setPassword('')
    if (!result.ok) throw new Error(result.message)
    setStatus(result.data); setAction('login'); setNotice('已登录。本机连接不会自动上传。')
  })
  const refreshConnections = async () => {
    const local = await window.omnidesk.connections.list()
    if (local.ok) useApp.getState().setConnections(local.data)
  }

  return <div className="account-workspace">
    <header className="account-heading"><div><div className="eyebrow">OPTIONAL / CLOUD</div><h1>账号与同步</h1><p>辅助功能，按需使用。本机 SSH、RDP、公共凭据和 WebDAV 不需要账号。</p></div><div className="account-mode"><Icon name={userId ? 'user' : 'shield'} size={18} /><span>{status?.user?.username ?? '本地模式'}<small>{userId ? '已登录' : '不登录也能正常使用'}</small></span></div></header>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}{notice && <div className="alert alert-success" role="status">{notice}</div>}
    <section className="account-service card"><details open={!status?.serverUrl || undefined}><summary>账号服务地址 <span className="mono">{status?.serverUrl || '未配置 · 可选'}</span></summary><div className="account-service-form"><label className="field">服务器地址<input aria-label="官方服务地址" value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="请输入 HTTP 或 HTTPS 账号服务地址" disabled={busy} /></label><button className="btn" disabled={busy || !status || serverUrl === status.serverUrl} onClick={() => void operate(async () => { await configure(); setNotice(serverUrl.trim() ? '服务地址已保存；更换服务后需重新登录。' : '已清空账号服务地址，本机连接不受影响。') })}>保存服务地址</button></div><p className="field-hint">默认不连接任何账号服务，请自行填写。支持 HTTP 和 HTTPS，内网服务可填写 HTTP 地址。清空或更换服务不删除本机连接。</p></details></section>
    {!userId ? <section className="account-login-grid"><div className="account-login card">
      <div className="segmented" role="tablist" aria-label="官方账号登录或注册"><button role="tab" aria-selected={action === 'login'} data-active={action === 'login'} disabled={busy} onClick={() => setAction('login')}>登录账号</button><button role="tab" aria-selected={action === 'register'} data-active={action === 'register'} disabled={busy || providers?.registrationOpen === false} onClick={() => setAction('register')}>注册账号</button></div>
      {providers?.registrationOpen === false && <p className="field-hint">管理员已关闭新账号注册，已有账号仍可登录。</p>}
      <form onSubmit={event => { event.preventDefault(); void authenticate() }}><label className="field">账号<input aria-label="官方账号" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]{3,32}" placeholder="3–32 位字母、数字或下划线" disabled={busy} required /></label><label className="field">密码<input aria-label="官方账号密码" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={action === 'register' ? 'new-password' : 'current-password'} minLength={10} maxLength={1024} placeholder="至少 10 个字符" disabled={busy} required /></label><button className="btn btn-primary" type="submit" disabled={busy || !status || !serverUrl.trim()}>{busy ? '正在连接…' : action === 'register' ? '注册并登录' : '登录账号'}<Icon name="arrow" size={16} /></button></form>
      <GitlabLogin providers={providers} mode="login" busy={busy} onBusy={setBusy} onComplete={setStatus} />
    </div><div className="account-local-note"><Icon name="layers" size={32} /><h2>工作在本地，配置按需流转。</h2><p>共享只是把选定的配置发布到云端，其他用户下载后成为自己的本地连接；服务器流量不经过云端。</p><p>已有账号请先登录再绑定企业账号，保留原同步与共享数据。登录不会自动上传任何服务器。</p></div></section> : <>
      <section className="account-identity"><div>{status?.user?.gitlab ? <p className="account-gitlab-linked"><Icon name="gitlab" size={17} />已绑定企业账号：{status.user.gitlab.username}<span className="muted">{new URL(status.user.gitlab.issuer).hostname}</span></p> : <GitlabLogin providers={providers} mode="link" busy={busy} onBusy={setBusy} onComplete={setStatus} />}</div><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void operate(async () => { const result = await window.omnidesk.account.logout(); if (!result.ok) throw new Error(result.message); setStatus(result.data); setNotice('已退出账号，本机连接和凭据保留。') })}>退出账号</button></section>
      <section className="account-sharing-link card"><div><h2>共享服务器已独立到专门的页面</h2><p className="field-hint">查看、发布和拉取共享服务器，请前往侧栏「共享服务器」。管理员在服务端 Web 管理台维护团队配置。</p></div><button className="btn" onClick={() => useApp.getState().openTab({ id: 'tab-shared-servers', kind: 'shared-servers', title: '共享服务器', status: 'idle' })}><Icon name="layers" size={16} />打开共享服务器</button></section>
      <details className="account-sync card"><summary><Icon name="cloud" size={17} />我的配置同步<span>同一账号的多端备份 · 按需展开</span></summary><p className="field-hint">仅当前账号可访问，与共享服务器目录分开管理。同步密钥由账号服务保管。</p><div className="account-sync-actions"><div><span className="field-label">本机已知云端版本</span><strong>#{status?.revision ?? 0}</strong><small>{status?.lastSync ? '上次操作 ' + new Date(status.lastSync).toLocaleString() : '尚未同步'}</small></div><button className="btn" disabled={busy} onClick={() => void operate(async () => { try { const result = await window.omnidesk.account.upload(); if (!result.ok) throw new Error(result.message); setStatus(result.data); setNotice('本机配置已加密同步到云端。其他设备登录同一账号后可拉取。') } finally { await refreshConnections() } })}>上传本机配置</button><button className="btn" disabled={busy} onClick={() => void operate(async () => { const result = await window.omnidesk.account.download(); if (!result.ok) throw new Error(result.message); if (!result.data) return; await refreshConnections(); setNotice(`已拉取合并 ${result.data.connections} 条连接、${result.data.sharedCredentials} 条公共凭据。`) })}>拉取云端配置</button></div><p className="field-hint">上传前检查云端版本；有更新时先确认合并，再上传，并自动重试版本冲突。保留本机独有记录，同 ID 使用云端内容，不同步删除操作。</p></details>
    </>}
  </div>
}
