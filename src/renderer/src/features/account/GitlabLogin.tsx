import { useEffect, useRef, useState } from 'react'
import type { OfficialAccountStatus, OfficialAuthProviders } from '@shared/account'
import Icon from '../../components/Icon'

export default function GitlabLogin({ providers, mode, busy, onBusy, onComplete }: {
  providers: OfficialAuthProviders | null
  mode: 'login' | 'link'
  busy: boolean
  onBusy: (value: boolean) => void
  onComplete: (status: OfficialAccountStatus) => void
}) {
  const [attempt, setAttempt] = useState<{ id: string; expiresAt: number } | null>(null)
  const [error, setError] = useState('')
  let providerHost = ''
  try { providerHost = providers?.gitlab.issuer ? new URL(providers.gitlab.issuer).hostname : '' } catch {}
  const mounted = useRef(true)
  const callbacks = useRef({ onBusy, onComplete })
  callbacks.current = { onBusy, onComplete }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!attempt) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (attempt.expiresAt <= Date.now()) throw new Error('GitLab 登录已过期，请重新发起')
        const result = await window.omnidesk.account.pollGitlab(attempt.id)
        if (stopped) return
        if (!result.ok) throw new Error(result.message)
        if (result.data.state === 'complete' && result.data.status) {
          callbacks.current.onComplete(result.data.status)
          callbacks.current.onBusy(false)
          setAttempt(null)
        } else timer = setTimeout(() => void poll(), 1500)
      } catch (error) {
        if (!stopped) { setError(error instanceof Error ? error.message : 'GitLab 登录失败'); setAttempt(null); callbacks.current.onBusy(false) }
      }
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { stopped = true; clearTimeout(timer); void window.omnidesk.account.cancelGitlab(attempt.id).catch(() => {}); callbacks.current.onBusy(false) }
  }, [attempt])
  const start = async () => {
    onBusy(true); setError('')
    try {
      const result = await window.omnidesk.account.startGitlab(mode)
      if (!result.ok) throw new Error(result.message)
      if (!mounted.current) { void window.omnidesk.account.cancelGitlab(result.data.id); return }
      setAttempt(result.data)
    } catch (error) { if (mounted.current) { setError(error instanceof Error ? error.message : '无法开始 GitLab 登录'); onBusy(false) } }
  }
  return <div className="account-gitlab">
    {attempt ? <div className="account-gitlab-wait" role="status"><Icon name="gitlab" size={23} /><div><strong>等待浏览器授权</strong><p>请在系统浏览器完成 {providerHost || '企业账号'} 授权，并保持当前页面打开；完成后会自动登录。</p></div><button className="btn btn-ghost btn-sm" onClick={() => { setAttempt(null); onBusy(false) }}>取消登录</button></div> : <>
      <button type="button" className="btn account-gitlab-button" disabled={busy || !providers?.gitlab.enabled} onClick={() => void start()}><Icon name="gitlab" size={21} />{mode === 'link' ? '绑定企业账号' : '使用企业账号登录'}<Icon name="arrow" size={15} /></button>
      <p className="field-hint">{providers?.gitlab.enabled ? `${providerHost} · OAuth 授权${mode === 'link' ? '，保留当前账号的同步与共享数据。' : '，不在 OmniDesk 中收集企业账号密码。'}` : '管理员启用企业账号 OAuth 后可使用，普通账号登录不受影响。'}</p>
    </>}
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
  </div>
}
