import ConfigurationSync from '../settings/ConfigurationSync'
import MonitoringSettings from '../monitor/MonitoringSettings'
import { useEffect, useRef, useState } from 'react'
import type { OfficialAccountStatus, OfficialAuthProviders } from '@shared/account'
import { useApp } from '../../store/app'
import Icon from '../../components/Icon'
import GitlabLogin from './GitlabLogin'
import AccountRemoveDialog from './AccountRemoveDialog'

export default function AccountView() {
  const [status, setStatus] = useState<OfficialAccountStatus | null>(null)
  const [providers, setProviders] = useState<OfficialAuthProviders | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [action, setAction] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [panel,setPanel]=useState<'sync'|'monitor'>('sync')
  const [adding,setAdding]=useState(false)
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState<NonNullable<OfficialAccountStatus['accounts']>[number] | null>(null)
  const selectedAccount = !adding ? status?.accounts?.find(item => item.id === status.activeAccountId) : undefined
  const userId = status?.user?.id
  const passwordInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding || userId || !status?.activeAccountId) return
    const profile = status.accounts?.find(item => item.id === status.activeAccountId)
    if (!profile) return
    setUsername(profile.user.username); setPassword(''); setAction('login')
    const focus = requestAnimationFrame(() => passwordInput.current?.focus())
    return () => cancelAnimationFrame(focus)
  }, [status?.activeAccountId, userId, adding])

  useEffect(()=>window.omnidesk.account.onChanged(next=>{setStatus(next);setServerUrl(next.serverUrl)}),[])
  useEffect(() => {
    let active = true
    void window.omnidesk.account.status().then(result => { if (active && result.ok) { setStatus(result.data); setServerUrl(result.data.serverUrl) } }).catch(() => { if (active) setError('读取账号状态失败') })
    return () => { active = false }
  }, [])
  useEffect(() => { if (status) useApp.getState().setAccountStatus(status) }, [status])
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
    setStatus(result.data); setAdding(false); setAction('login'); setNotice('已登录。本机连接不会自动上传。')
  })
  const refreshConnections = async () => {
    const local = await window.omnidesk.connections.list()
    if (local.ok) useApp.getState().setConnections(local.data)
  }

  const selectAccount = async (id: string) => {
    if (id === '__add__') { setAdding(true); setUsername(''); setPassword(''); return }
    await operate(async () => {
      const result = await window.omnidesk.account.switchAccount(id)
      if (!result.ok) throw new Error(result.message)
      setStatus(result.data); setServerUrl(result.data.serverUrl); setAdding(false)
      setUsername(result.data.accounts?.find(item => item.id === id)?.user.username ?? '')
      setPassword(''); setAction('login')
      setNotice(result.data.user ? '已切换账号，本机连接保留。' : '该账号需要重新登录，已填好服务地址和账号，请输入密码。')
    })
  }

  return <div className="account-workspace">
    <header className="account-heading"><div><div className="eyebrow">OPTIONAL / CLOUD</div><h1>账号</h1><p>辅助功能，按需使用。本机 SSH、RDP、公共凭据和 WebDAV 不需要账号。</p></div><div className="account-mode"><Icon name={userId ? 'user' : 'shield'} size={18} /><span>{status?.user?.username ?? '本地模式'}<small>{userId ? '已登录' : '不登录也能正常使用'}</small></span></div></header>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}{notice && <div className="alert alert-success" role="status">{notice}</div>}
    <div className="account-profile-switch"><label className="field">当前账号<select aria-label="切换云端账号" value={adding ? '__add__' : status?.activeAccountId ?? ''} disabled={busy} onChange={event => void selectAccount(event.target.value)}><option value="" disabled>本地模式</option>{status?.accounts?.map(item=><option key={item.id} value={item.id}>{item.user.username} · {new URL(item.serverUrl).host}{item.signedIn ? '' : ' · 需重新登录'}</option>)}<option value="__add__">＋ 添加其他账号</option></select></label>{selectedAccount && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRemoving(selectedAccount)}>从本机移除</button>}{adding && <button className="btn btn-ghost btn-sm" onClick={()=>setAdding(false)}>取消添加</button>}</div>
    {removing && <AccountRemoveDialog account={removing} onClose={() => setRemoving(null)} onRemoved={next => {
      setStatus(next); setServerUrl(next.serverUrl); setAdding(false); setUsername(''); setPassword(''); setAction('login'); setError('')
      setNotice(`已从本机移除账号「${removing.user.username}」。云端账号和数据保留。`); setRemoving(null)
    }} />}
    <section className="account-service card"><details open={!status?.serverUrl || undefined}><summary>统一云端地址 <span className="mono">{status?.serverUrl || '未配置 · 可选'}</span></summary><div className="account-service-form"><label className="field">服务器地址<input aria-label="官方服务地址" value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="请输入统一云端 HTTP 或 HTTPS 地址" disabled={busy} /></label>{(status?.serverHistory?.length ?? 0) > 0 && <label className="field account-server-history">历史地址<select aria-label="最近使用的服务器地址" value="" disabled={busy} onChange={event => setServerUrl(event.target.value)}><option value="" disabled>选择已保存的地址</option>{status?.serverHistory?.map(address => <option key={address} value={address}>{address}</option>)}</select></label>}<button className="btn" disabled={busy || !status || serverUrl === status.serverUrl} onClick={() => void operate(async () => { await configure(); setNotice(serverUrl.trim() ? '服务地址已保存；已有登录账号已保留，可从账号菜单切回。' : '已清空账号服务地址，本机连接不受影响。') })}>保存服务地址</button></div><p className="field-hint">账号、同步与监控共用此地址。支持 HTTP 和 HTTPS，内网服务可填写 HTTP 地址。清空或更换服务不删除本机连接。</p></details></section>
    {!userId || adding ? <section className="account-login-grid"><div className="account-login card">
      <div className="segmented" role="tablist" aria-label="官方账号登录或注册"><button role="tab" aria-selected={action === 'login'} data-active={action === 'login'} disabled={busy} onClick={() => setAction('login')}>登录账号</button><button role="tab" aria-selected={action === 'register'} data-active={action === 'register'} disabled={busy || providers?.registrationOpen === false} onClick={() => setAction('register')}>注册账号</button></div>
      {providers?.registrationOpen === false && <p className="field-hint">管理员已关闭新账号注册，已有账号仍可登录。</p>}
      <form onSubmit={event => { event.preventDefault(); void authenticate() }}><label className="field">账号<input aria-label="官方账号" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]{3,32}" placeholder="3–32 位字母、数字或下划线" disabled={busy} required /></label><label className="field">密码<input aria-label="官方账号密码" ref={passwordInput} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={action === 'register' ? 'new-password' : 'current-password'} minLength={6} maxLength={1024} placeholder="至少 6 个字符" disabled={busy} required /></label><button className="btn btn-primary" type="submit" disabled={busy || !status || !serverUrl.trim()}>{busy ? '正在连接…' : action === 'register' ? '注册并登录' : '登录账号'}<Icon name="arrow" size={16} /></button></form>
      <GitlabLogin providers={providers} mode="login" busy={busy} onBusy={setBusy} onComplete={setStatus} />
    </div><div className="account-local-note"><Icon name="layers" size={32} /><h2>工作在本地，配置按需流转。</h2><p>共享只是把选定的配置发布到云端，其他用户下载后成为自己的本地连接；服务器流量不经过云端。</p><p>已有账号请先登录再绑定企业账号，保留原同步与共享数据。登录不会自动上传任何服务器。</p></div></section> : <>
      <section className="account-identity"><div>{status?.user?.gitlab ? <p className="account-gitlab-linked"><Icon name="gitlab" size={17} />已绑定企业账号：{status.user.gitlab.username}<span className="muted">{new URL(status.user.gitlab.issuer).hostname}</span></p> : <GitlabLogin providers={providers} mode="link" busy={busy} onBusy={setBusy} onComplete={setStatus} />}</div><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void operate(async () => { const result = await window.omnidesk.account.logout(); if (!result.ok) throw new Error(result.message); setStatus(result.data); setNotice('已退出账号，本机连接和凭据保留。') })}>退出账号</button></section>


    </>}
    <div className="segmented account-settings-tabs" role="tablist" aria-label="账号设置"><button role="tab" aria-selected={panel==='sync'} data-active={panel==='sync'} onClick={()=>setPanel('sync')}>配置同步</button><button role="tab" aria-selected={panel==='monitor'} data-active={panel==='monitor'} onClick={()=>setPanel('monitor')}>云端监控</button></div>
    <section hidden={panel!=='sync'} className="account-sync" aria-label="配置同步"><h2>配置同步</h2><ConfigurationSync key={status?.activeAccountId ?? 'local'} embedded destination="account" accountKey={status?.activeAccountId}/></section>
    <section hidden={panel!=='monitor'} className="account-monitoring" aria-label="云端监控"><h2>云端监控</h2><MonitoringSettings key={status?.activeAccountId ?? 'local'}/></section>
  </div>
}
