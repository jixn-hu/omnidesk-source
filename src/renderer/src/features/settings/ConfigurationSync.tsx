import ActionButton from '../../components/ActionButton'
import { BACKUP_LABELS, BACKUP_SECTIONS, type BackupOptions, type BackupSection } from '@shared/backup'
import type { OfficialAccountStatus } from '@shared/account'
import { normalizeAppearance, useAppearance } from '../../store/appearance'
import { useEffect, useState } from 'react'
import type { IpcResult, ConfigurationSummary, WebDavConfiguration } from '@shared/types'
import { buildWebDavLocation, splitWebDavLocation, type WebDavLocation } from '@shared/webdav-location'
import { useApp } from '../../store/app'

function result<Value>(response: IpcResult<Value>): Value {
  if (!response.ok) throw new Error(response.message)
  return response.data
}

export default function ConfigurationSync({ embedded = false, accountKey, destination: placement = 'backup' }: { embedded?: boolean; accountKey?: string; destination?: 'backup' | 'account' }) {
  const accountOnly = placement === 'account'
  const choicesKey='omnidesk.backup.sections'+(accountKey ? ':'+accountKey : '')
  const unlocked = useApp((state) => state.vaultStatus === 'unlocked')
  const [password, setPassword] = useState('')
  const [savedPassword, setSavedPassword] = useState(false)
  const [rememberPassword, setRememberPassword] = useState(true)
  const [section, setSection] = useState<'file' | 'webdav' | 'account'>(() => {
    if (accountOnly) return 'account'
    return localStorage.getItem('omnidesk.backup.destination') === 'webdav' ? 'webdav' : 'file'
  })
  const [choices, setChoices] = useState<Partial<Record<'file' | 'webdav' | 'account', BackupSection[]>>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(choicesKey) || '{}')
      return Object.fromEntries(['file', 'webdav', 'account'].filter(key => Array.isArray(saved?.[key]) && saved[key].every((item: BackupSection) => BACKUP_SECTIONS.includes(item))).map(key => [key, saved[key]]))
    } catch { return {} }
  })
  const [monitorConfigured, setMonitorConfigured] = useState(false)
  const [account, setAccount] = useState<OfficialAccountStatus>()
  const sections = choices[section] ?? (monitorConfigured ? ['monitoring', 'preferences'] : ['preferences']) as BackupSection[]
  const choose = (key: BackupSection, checked: boolean) => {
    const next = { ...choices, [section]: checked ? [...sections, key] : sections.filter(item => item !== key) }
    setChoices(next); localStorage.setItem(choicesKey, JSON.stringify(next))
  }
  const changeDestination = (next: 'file' | 'webdav' | 'account') => {
    setSection(next); setMessage(null); if (next !== 'account') localStorage.setItem('omnidesk.backup.destination', next)
  }
  const options = (): BackupOptions => ({ sections, preferences: { appearance: { ...normalizeAppearance(useAppearance.getState()) }, monitorView: localStorage.getItem('omnidesk.monitor.view') === 'list' ? 'list' : 'cards' } })
  const [serverPassword, setServerPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [configuration, setConfiguration] = useState<WebDavConfiguration>({ url: '', username: '', allowInsecureHttp: false, hasPassword: false })
  const [location, setLocation] = useState<WebDavLocation>(() => splitWebDavLocation(''))
  const [locationDirty, setLocationDirty] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [completed, setCompleted] = useState('')
  useEffect(() => { if (!completed) return; const timer = setTimeout(() => setCompleted(''), 1600); return () => clearTimeout(timer) }, [completed])
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const api = window.omnidesk.configuration

  useEffect(() => {
    const refresh = () => {
      void window.omnidesk.monitoring.local().then(response => { if (response.ok) {setMonitorConfigured(!!response.data.config.url.trim());} })
      void window.omnidesk.account.status().then(response => { if (response.ok) { setAccount(response.data); useApp.getState().setAccountStatus(response.data) } })
    }
    refresh()
    window.addEventListener('omnidesk:monitoring-changed', refresh)
    return () => { window.removeEventListener('omnidesk:monitoring-changed', refresh) }
  }, [])

  useEffect(() => {
    void api.passwordStatus().then(response => { if (response.ok) setSavedPassword(response.data) })
    void api.webdav().then((response) => {
      if (response.ok) loadConfiguration(response.data)
      else setMessage({ ok: false, text: response.message })
    })
  }, [])

  const loadConfiguration = (saved: WebDavConfiguration) => {
    setConfiguration(saved)
    setLocation(splitWebDavLocation(saved.url, saved.serverUrl))
    setLocationDirty(false)
  }

  const run = async (label: string, action: () => Promise<string>) => {
    if (busy) return
    setBusy(label)
    setCompleted('')
    setMessage(null)
    try {
      let text = await action()
      if (password && rememberPassword && ['导出备份', '导入备份', '上传 WebDAV', '下载 WebDAV'].includes(label) && !text.startsWith('已取消')) {
        const saved = await api.savePassword(password)
        if (saved.ok) setSavedPassword(saved.data)
        else text += '；操作已完成，但本机记住备份密码失败：' + saved.message
      }
      setMessage({ ok: true, text })
      if (!text.startsWith('已取消')) setCompleted(label)
    }
    catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : '操作失败，请重试' }) }
    finally { setBusy('') }
  }

  const imported = async (summary: ConfigurationSummary | null): Promise<string> => {
    if (!summary) return '已取消，未修改本地配置'
    useApp.getState().setConnections(result(await window.omnidesk.connections.list()))
    loadConfiguration(result(await api.webdav()))
    return `已恢复${summary.sections?.length ? '（' + summary.sections.map(key => BACKUP_LABELS[key]).join('、') + '）' : ''}。已导入 ${summary.connections} 条连接，跳过 ${summary.skipped ?? 0} 条重复项、${summary.sharedCredentials} 条公共凭据。现有会话不受影响，新凭据在下次连接时生效。${summary.warning ? `注意：${summary.warning}` : ''}`
  }

  const update = (patch: Partial<WebDavConfiguration>) => {
    setConfiguration((current) => ({ ...current, ...patch }))
    setDirty(true)
  }

  const updateLocation = (patch: Partial<WebDavLocation>) => {
    setLocation((current) => ({ ...current, ...patch }))
    setLocationDirty(true)
    setDirty(true)
  }

  let destination = ''
  try { destination = locationDirty ? buildWebDavLocation(location).url : configuration.url } catch {}

  const disabled = !!busy || !unlocked
  const remoteDisabled = disabled || !location.serverUrl.trim()
  const saveRemote = async () => {
    if (!dirty && configuration.url) return
    const target = locationDirty ? buildWebDavLocation(location) : { url: configuration.url, serverUrl: location.serverUrl }
    const saved = result(await api.saveWebdav({ ...target, username: configuration.username, allowInsecureHttp: configuration.allowInsecureHttp, password: serverPassword, clearPassword }))
    loadConfiguration(saved)
    setServerPassword('')
    setClearPassword(false)
    setDirty(false)
  }

  return (
    <div className="card" style={{ marginBottom: embedded ? 0 : 14 }}>
      {!embedded && <div className="card-title">{accountOnly ? '配置同步' : '备份'}</div>}
      <div className="card-desc">选择要备份的内容，再选择保存位置。基础连接资料固定包含；可选内容按本次勾选导出或恢复，恢复前会预览并确认。</div>
      {!accountOnly && <div className="backup-tabs" role="tablist" aria-label="备份方式">
        <button role="tab" aria-selected={section === 'file'} disabled={!!busy} onClick={() => changeDestination('file')}>本地文件</button>
        <button role="tab" aria-selected={section === 'webdav'} disabled={!!busy} onClick={() => changeDestination('webdav')}>WebDAV</button>
      </div>}
      <fieldset className="backup-contents" disabled={disabled}>
        <legend>备份与恢复内容</legend>
        <label className="configuration-choice backup-content"><input type="checkbox" checked disabled /><span><strong>基础连接资料</strong><small>固定包含 SSH / RDP 连接、分组、标签、备注、连接选项、公共凭据及关联密码和私钥。</small></span><em>必选</em></label>
        {BACKUP_SECTIONS.map(key => <label key={key} className="configuration-choice backup-content"><input type="checkbox" checked={sections.includes(key)} onChange={event => choose(key, event.target.checked)} /><span><strong>{BACKUP_LABELS[key]}</strong><small>{{
          monitoring: '监控开关、上报周期及当前账号的节点关联；服务端指标历史由云端保存。',
          preferences: '主题、字体、终端样式、目录显示及监控卡片 / 列表偏好。',
          aiSettings: 'AI 接口、模型、默认权限与调用上限，不含 API Key。',
          aiHistory: '合并聊天记录；恢复后不会继续旧任务或执行旧确认。',
          serviceCredentials: '采集端令牌、AI API Key。仅恢复到匹配的账号和服务地址。'
        }[key]}</small></span>{key === 'serviceCredentials' && <em>敏感</em>}</label>)}
      </fieldset>
      <p className="field-hint">各保存位置分别记住勾选。未选内容保留本机现状；旧版备份可继续恢复。账号登录态、WebDAV 密码、设备密钥和主机信任记录不迁移。</p>
      <div hidden={section === 'account'}>
      <label className="field" htmlFor="configuration-password">
        <span className="field-label">备份加密密码</span>
        <input id="configuration-password" aria-label="备份加密密码" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={disabled} placeholder={savedPassword ? '已记住；留空使用本机保存的密码' : '设置备份密码；恢复时输入原备份的密码'} />
        <span className="field-hint">不同设备恢复时使用同一密码，与 WebDAV 登录密码无关。支持任意非空密码，建议使用较长密码。</span>
      </label>
      <div className="backup-password-options">
        <label className="configuration-choice"><input type="checkbox" checked={rememberPassword} disabled={disabled} onChange={event => setRememberPassword(event.target.checked)} />在本机保险箱记住备份密码</label>
        {savedPassword && <button className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => void run('忘记密码', async () => { setSavedPassword(result(await api.savePassword(''))); setRememberPassword(false); return '已忘记本机保存的备份密码' })}>忘记已保存的密码</button>}
      </div>
      </div>
      <div hidden={section !== 'file'}>
      <p className="field-hint">导出到文件，或将另一台电脑的备份合并到本机。同 ID 更新，相同服务器的不同 ID 默认跳过。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <ActionButton phase={busy === '导出备份' ? 'busy' : completed === '导出备份' ? 'success' : 'idle'} icon="import" className="btn" disabled={disabled} onClick={() => void run('导出备份', async () => {
          const saved = result(await api.exportFile(password, options()))
          return saved.cancelled ? '已取消导出' : `加密备份已导出：${saved.path}`
        })}>备份到文件</ActionButton>
        <ActionButton phase={busy === '导入备份' ? 'busy' : completed === '导入备份' ? 'success' : 'idle'} icon="folder" className="btn" disabled={disabled} onClick={() => void run('导入备份', async () => await imported(result(await api.importFile(password, options()))))}>从文件恢复</ActionButton>
      </div>
      <div className="field-hint" style={{ marginBottom: 18 }}>XTerminal / RDO 配置可从「服务器管理 → 导入连接」迁移。备份导入会更新同 ID 记录，不删除本地其他连接；不会自动授权外部访问。</div>

      </div>
      <div hidden={section !== 'webdav'} style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
        <div className="card-title">WebDAV 服务器</div>
        <label className="field" htmlFor="webdav-url">
          <span id="webdav-url-label" className="field-label">服务器地址</span>
          <input id="webdav-url" aria-labelledby="webdav-url-label" aria-describedby="webdav-url-hint" type="url" className="mono" value={location.serverUrl} disabled={disabled} onChange={(event) => updateLocation({ serverUrl: event.target.value })} placeholder="https://dav.example.com/dav/" spellCheck={false} />
          <span id="webdav-url-hint" className="field-hint">填写服务提供的 WebDAV 地址，无需拼接文件名。默认将 OmniDesk.odbackup 保存到此地址下。</span>
        </label>
        <div className="field-row">
          <label className="field" htmlFor="webdav-username">
            <span className="field-label">账号</span>
            <input id="webdav-username" autoComplete="off" value={configuration.username} disabled={disabled} onChange={(event) => update({ username: event.target.value })} />
          </label>
          <label className="field" htmlFor="webdav-password">
            <span id="webdav-password-label" className="field-label">密码</span>
            <input id="webdav-password" aria-labelledby="webdav-password-label" aria-describedby="webdav-password-hint" type="password" autoComplete="new-password" value={serverPassword} disabled={disabled} placeholder={configuration.hasPassword ? '已保存；留空保持不变' : '保存在本机加密保险箱'} onChange={(event) => { setServerPassword(event.target.value); setDirty(true) }} />
            <span id="webdav-password-hint" className="field-hint">支持服务商提供的应用密码，与上方备份加密密码不同。</span>
          </label>
        </div>
        {configuration.hasPassword && <label className="configuration-choice">
          <input type="checkbox" checked={clearPassword} disabled={disabled} onChange={(event) => { setClearPassword(event.target.checked); setDirty(true) }} /><span>清除已保存的 WebDAV 密码</span>
        </label>}
        <details className="configuration-advanced">
          <summary>备份位置与高级设置（可选）</summary>
          <div className="field-row">
            <label className="field" htmlFor="webdav-directory">
              <span id="webdav-directory-label" className="field-label">备份目录</span>
              <input id="webdav-directory" aria-labelledby="webdav-directory-label" aria-describedby="webdav-directory-hint" value={location.directory} disabled={disabled} onChange={(event) => updateLocation({ directory: event.target.value })} placeholder="留空使用服务器地址对应的目录" spellCheck={false} />
              <span id="webdav-directory-hint" className="field-hint">相对于服务器地址，例如 backups/OmniDesk；上传时会自动创建备份子目录。</span>
            </label>
            <label className="field" htmlFor="webdav-filename">
              <span id="webdav-filename-label" className="field-label">备份文件名</span>
              <input id="webdav-filename" aria-labelledby="webdav-filename-label" aria-describedby="webdav-filename-hint" value={location.filename} disabled={disabled} onChange={(event) => updateLocation({ filename: event.target.value })} placeholder="OmniDesk.odbackup" spellCheck={false} />
              <span id="webdav-filename-hint" className="field-hint">默认 OmniDesk.odbackup；同一位置用于上传和下载。</span>
            </label>
          </div>
          <label className="configuration-choice">
            <input type="checkbox" checked={configuration.allowInsecureHttp} disabled={disabled} onChange={(event) => update({ allowInsecureHttp: event.target.checked })} /><span>允许不安全 HTTP（WebDAV 账号和密码可能被窃听）</span>
          </label>
        </details>
        {destination && <div className="field-hint configuration-destination">备份位置：<span className="mono">{destination}</span></div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <ActionButton phase={busy === '保存 WebDAV' ? 'busy' : completed === '保存 WebDAV' ? 'success' : 'idle'} icon="check" className="btn" disabled={disabled || !location.serverUrl.trim()} onClick={() => void run('保存 WebDAV', async () => {
            await saveRemote()
            return 'WebDAV 配置已保存；WebDAV 账号密码保留在本机保险箱'
          })}>保存 WebDAV</ActionButton>
          <ActionButton phase={busy === '测试 WebDAV' ? 'busy' : completed === '测试 WebDAV' ? 'success' : 'idle'} icon="link" className="btn" disabled={remoteDisabled} onClick={() => void run('测试 WebDAV', async () => { await saveRemote(); return result(await api.testWebdav()) })}>测试连接</ActionButton>
          <ActionButton phase={busy === '上传 WebDAV' ? 'busy' : completed === '上传 WebDAV' ? 'success' : 'idle'} icon="cloud" className="btn btn-primary" disabled={remoteDisabled} onClick={() => void run('上传 WebDAV', async () => {
            await saveRemote()
            const message = result(await api.uploadWebdav(password, options()))
            setConfiguration(result(await api.webdav()))
            return message
          })}>备份到云端</ActionButton>
          <ActionButton phase={busy === '下载 WebDAV' ? 'busy' : completed === '下载 WebDAV' ? 'success' : 'idle'} icon="import" className="btn" disabled={remoteDisabled} onClick={() => void run('下载 WebDAV', async () => { await saveRemote(); return await imported(result(await api.downloadWebdav(password, options()))) })}>从云端恢复</ActionButton>
        </div>
        {dirty && <div className="field-hint" style={{ marginTop: 10 }}>测试或同步时会自动保存当前配置。</div>}
        {configuration.lastSync && <div className="field-hint" style={{ marginTop: 10 }}>最近成功同步：{new Date(configuration.lastSync).toLocaleString('zh-CN')}</div>}
      </div>
      <div hidden={section !== 'account'} className="backup-account">
        <div className="card-title">账号云端</div>
        <p className="field-hint">{account?.serverUrl || '尚未配置账号服务'}{account?.user ? ` · ${account.user.username} · 云端版本 #${account.revision}` : ' · 请先登录账号'}</p>
        <p className="field-hint">仅当前账号可访问，同步密钥由账号服务保管。上传前检查云端版本；有更新时先确认合并，再上传。不会同步删除操作。</p>
        <div className="backup-actions">
          <ActionButton phase={busy === '上传账号云端' ? 'busy' : completed === '上传账号云端' ? 'success' : 'idle'} icon="cloud" className="btn btn-primary" disabled={disabled || !account?.user} onClick={() => void run('上传账号云端', async () => {
            try {
              const status = result(await window.omnidesk.account.upload(options()))
              setAccount(status); useApp.getState().setAccountStatus(status)
              if (status.restored) await imported(status.restored)
              return '所选内容已加密备份到账号云端'
            } finally { useApp.getState().setConnections(result(await window.omnidesk.connections.list())) }
          })}>上传本机配置</ActionButton>
          <ActionButton phase={busy === '恢复账号云端' ? 'busy' : completed === '恢复账号云端' ? 'success' : 'idle'} icon="import" className="btn" disabled={disabled || !account?.user} onClick={() => void run('恢复账号云端', async () => {
            const message = await imported(result(await window.omnidesk.account.download(options())))
            setAccount(result(await window.omnidesk.account.status()))
            return message
          })}>拉取云端配置</ActionButton>
          <button className="btn btn-ghost" disabled={!!busy} onClick={() => useApp.getState().openTab({ id: 'tab-account', kind: 'account', title: '账号', status: 'idle' })}>管理账号</button>
        </div>
      </div>
      {!unlocked && <div className="field-hint" style={{ marginTop: 12 }}>请先解锁保险箱再备份或同步。</div>}
      {busy && <div role="status" className="field-hint" style={{ marginTop: 12 }}>{busy}中，请稍候…</div>}
      {message && <div role={message.ok ? 'status' : 'alert'} style={{ marginTop: 12, fontSize: 12, color: message.ok ? 'var(--text-secondary)' : 'var(--danger)', overflowWrap: 'anywhere', lineHeight: 1.6 }}>{message.text}</div>}
    </div>
  )
}
