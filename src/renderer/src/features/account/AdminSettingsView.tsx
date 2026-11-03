import { useEffect, useState } from 'react'
import type { OfficialAdminSettings } from '@shared/account'
import Icon from '../../components/Icon'

export default function AdminSettingsView({ serverUrl, onSaved }: { serverUrl: string; onSaved: (settings: OfficialAdminSettings) => void }) {
  const [settings, setSettings] = useState<OfficialAdminSettings | null>(null)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void window.omnidesk.account.settings().then(result => {
      if (!active) return
      if (result.ok) setSettings({ ...result.data, gitlab: { ...result.data.gitlab, redirectUri: result.data.gitlab.redirectUri || serverUrl + '/v1/auth/gitlab/callback' } })
      else setError(result.message)
    }).catch(() => { if (active) setError('无法加载管理员设置，请确认后台已更新') })
    return () => { active = false }
  }, [serverUrl])
  const field = (name: 'issuer' | 'clientId' | 'redirectUri', value: string) => setSettings(previous => previous && ({ ...previous, gitlab: { ...previous.gitlab, [name]: value } }))
  const save = async () => {
    if (!settings || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const { secretConfigured, ...gitlab } = settings.gitlab
      const result = await window.omnidesk.account.saveSettings({ registrationOpen: settings.registrationOpen, gitlab: { ...gitlab, clientSecret: secret || undefined } })
      if (!result.ok) throw new Error(result.message)
      setSettings(result.data); setSecret(''); onSaved(result.data); setNotice('设置已保存并立即生效。')
    } catch (error) { setError(error instanceof Error ? error.message : '保存设置失败') }
    finally { setBusy(false) }
  }
  return <section className="account-admin card" aria-label="管理员登录与注册设置">
    <div className="account-section-title"><div><h2><Icon name="settings" size={20} />登录与注册设置</h2><p>仅管理员可修改。设置保存在后台数据库，重启和升级后保留。</p></div><span className="badge">仅管理员</span></div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}{notice && <div className="alert alert-success" role="status">{notice}</div>}
    {settings && <form onSubmit={event => { event.preventDefault(); void save() }}>
      <label className="account-setting-toggle"><div><strong>允许新用户注册</strong><p>关闭后禁止普通注册和企业账号首次建号；已有用户登录、同步和共享不受影响。</p></div><input type="checkbox" role="switch" aria-label="允许新用户注册" checked={settings.registrationOpen} disabled={busy} onChange={event => setSettings({ ...settings, registrationOpen: event.target.checked })} /></label>
      <div className="account-gitlab-settings"><label className="account-setting-toggle"><div><strong><Icon name="gitlab" size={19} />企业账号登录 · GitLab OAuth</strong><p>使用公司的代码平台账号授权，例如 gitlab.example.com；不需要 GitLab.com 账号。</p></div><input type="checkbox" role="switch" aria-label="启用 GitLab 登录" checked={settings.gitlab.enabled} disabled={busy} onChange={event => setSettings({ ...settings, gitlab: { ...settings.gitlab, enabled: event.target.checked } })} /></label>
        <div className="account-settings-fields"><label className="field">GitLab 服务器地址<input aria-label="GitLab 服务器地址" value={settings.gitlab.issuer} onChange={event => field('issuer', event.target.value)} placeholder="https://gitlab.example.com" disabled={busy} /></label><label className="field">Application ID<input aria-label="GitLab Application ID" value={settings.gitlab.clientId} onChange={event => field('clientId', event.target.value)} autoComplete="off" disabled={busy} /></label><label className="field">Application Secret<input aria-label="GitLab Application Secret" type="password" value={secret} onChange={event => setSecret(event.target.value)} autoComplete="new-password" placeholder={settings.gitlab.secretConfigured ? '已配置；留空保留原密钥' : '填写 GitLab Application Secret'} disabled={busy} /></label><label className="field">授权回调地址<input aria-label="GitLab 授权回调地址" value={settings.gitlab.redirectUri} onChange={event => field('redirectUri', event.target.value)} disabled={busy} /></label></div>
        <p className="field-hint">在企业站点（如 https://gitlab.example.com/）的 Applications 创建 Confidential 应用，勾选 openid、profile，并登记完全一致的回调地址，支持 HTTP 或 HTTPS。Secret 加密保存，不会回显；更换站点或 Application ID 时需填写对应的新 Secret。授权失败页面会显示具体原因和排查编号，请重新发起登录，不要刷新旧回调。</p>
      </div><button className="btn btn-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存登录与注册设置'}</button>
    </form>}
  </section>
}
