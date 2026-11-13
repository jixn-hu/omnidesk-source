import { useEffect, useState } from 'react'
import type { AppUpdateStatus } from '@shared/updates'
import { useApp } from '../../store/app'
import Icon from '../../components/Icon'
import OpenSourceLinks from './OpenSourceLinks'
import { revealSettingsSection } from './SettingsSection'

function useUpdateStatus() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null)
  useEffect(() => {
    let active = true
    let changed = false
    const unsubscribe = window.omnidesk.updates.onChange(result => { changed = true; if (active) setStatus(result) })
    void window.omnidesk.updates.status().then(result => { if (active && !changed && result.ok) setStatus(result.data) }).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])
  return { status, setStatus }
}

export default function SoftwareUpdates({ embedded = false }: { embedded?: boolean }) {
  const { status, setStatus } = useUpdateStatus()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const operate = async (action: () => Promise<{ ok: boolean; message?: string; data?: AppUpdateStatus | boolean }>) => {
    setSaving(true); setError('')
    try {
      const result = await action()
      if (!result.ok) throw new Error(result.message || '更新操作失败')
      if (typeof result.data === 'object') setStatus(result.data)
    } catch (error) { setError(error instanceof Error ? error.message : '更新操作失败，请稍后重试') }
    finally { setSaving(false) }
  }
  const summary = !status ? '正在读取更新设置…' : status.checking ? '正在检查 GitHub Releases…' : status.error ? '本次检查未完成，未判定为最新版本' : status.available ? '发现新版本 ' + status.release?.version : status.lastCheckedAt ? '当前没有发现更新的正式版本' : '尚未检查更新'
  return <section className="card software-updates" aria-label="软件更新">
    <div className="software-update-heading"><div>{!embedded && <div className="card-title"><Icon name="refresh" size={17} />软件更新</div>}<div className="card-desc">从 GitHub Releases 检查正式版本。不需要官方账号，不上传服务器配置或凭据。</div></div>{status && <span className="badge">v{status.currentVersion}</span>}</div>
    <label className="software-update-toggle"><input type="checkbox" checked={status?.autoCheck ?? true} disabled={!status || saving} onChange={event => void operate(() => window.omnidesk.updates.setAutoCheck(event.target.checked))} /><span>启动后自动检查更新<small>每天最多自动检查一次；失败静默处理，不打断 SSH / RDP 会话。</small></span></label>
    <div className="software-update-summary" role="status"><strong>{summary}</strong>{status?.lastCheckedAt && <span>上次成功检查：{new Date(status.lastCheckedAt).toLocaleString()}</span>}</div>
    {(error || status?.error) && <div className="alert alert-warning" role="alert">{error || status?.error}</div>}
    {status?.available && status.release && <div className="software-update-release"><strong>{status.release.name || 'OmniDesk ' + status.release.version}</strong><span>{new Date(status.release.publishedAt).toLocaleDateString()}</span>{status.release.notes && <details><summary>查看更新说明</summary><pre>{status.release.notes}</pre></details>}</div>}
    <div className="software-update-actions"><button className="btn" disabled={!status || status.checking || saving} onClick={() => void operate(() => window.omnidesk.updates.check())}>{status?.checking ? '正在检查…' : '检查更新'}</button>{status?.available && <button className="btn btn-primary" disabled={saving} onClick={() => void operate(() => window.omnidesk.updates.openRelease())}>前往 GitHub 下载新版 ↗</button>}</div>
    <OpenSourceLinks />
  </section>
}

export function SoftwareUpdateNotice() {
  const { status } = useUpdateStatus()
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('omnidesk.update.dismissed') || '')
  if (!status?.available || !status.release || dismissed === status.release.version) return null
  const dismiss = () => { localStorage.setItem('omnidesk.update.dismissed', status.release!.version); setDismissed(status.release!.version) }
  return <aside className="software-update-notice" role="status" aria-label="新版本提示"><Icon name="refresh" size={20} /><div><strong>发现 OmniDesk {status.release.version}</strong><p>当前 v{status.currentVersion} · 不会自动中断远程会话</p><div className="software-update-actions"><button className="btn btn-primary btn-sm" onClick={() => { revealSettingsSection('updates'); useApp.getState().openTab({ id: 'tab-settings', kind: 'settings', title: '设置', status: 'idle' }); dismiss() }}>查看更新</button><button className="btn btn-ghost btn-sm" onClick={dismiss}>忽略此版本</button></div></div></aside>
}
