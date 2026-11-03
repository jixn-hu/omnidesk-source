import { useEffect, useState } from 'react'
import type { IpcResult, ConfigurationSummary, WebDavConfiguration } from '@shared/types'
import { buildWebDavLocation, splitWebDavLocation, type WebDavLocation } from '@shared/webdav-location'
import { useApp } from '../../store/app'

function result<Value>(response: IpcResult<Value>): Value {
  if (!response.ok) throw new Error(response.message)
  return response.data
}

export default function ConfigurationSync({ embedded = false }: { embedded?: boolean }) {
  const unlocked = useApp((state) => state.vaultStatus === 'unlocked')
  const [password, setPassword] = useState('')
  const [savedPassword, setSavedPassword] = useState(false)
  const [rememberPassword, setRememberPassword] = useState(true)
  const [section, setSection] = useState<'file' | 'webdav'>('file')
  const [serverPassword, setServerPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [configuration, setConfiguration] = useState<WebDavConfiguration>({ url: '', username: '', allowInsecureHttp: false, hasPassword: false })
  const [location, setLocation] = useState<WebDavLocation>(() => splitWebDavLocation(''))
  const [locationDirty, setLocationDirty] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const api = window.omnidesk.configuration

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
    setMessage(null)
    try {
      let text = await action()
      if (password && rememberPassword && ['导出备份', '导入备份', '上传 WebDAV', '下载 WebDAV'].includes(label) && !text.startsWith('已取消')) {
        const saved = await api.savePassword(password)
        if (saved.ok) setSavedPassword(saved.data)
        else text += '；操作已完成，但本机记住备份密码失败：' + saved.message
      }
      setMessage({ ok: true, text })
    }
    catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : '操作失败，请重试' }) }
    finally { setBusy('') }
  }

  const imported = async (summary: ConfigurationSummary | null): Promise<string> => {
    if (!summary) return '已取消，未修改本地配置'
    useApp.getState().setConnections(result(await window.omnidesk.connections.list()))
    loadConfiguration(result(await api.webdav()))
    return `已导入 ${summary.connections} 条连接，跳过 ${summary.skipped ?? 0} 条重复项、${summary.sharedCredentials} 条公共凭据。现有会话不受影响，新凭据在下次连接时生效。${summary.warning ? `注意：${summary.warning}` : ''}`
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
      {!embedded && <div className="card-title">配置备份与 WebDAV 同步</div>}
      <div className="card-desc">连接、分组、RDP 选项和公共凭据一起迁移。密码与 SSH 私钥随备份加密，不上传设备密钥、API 令牌或主机信任记录。</div>
      <label className="field" htmlFor="configuration-password">
        <span className="field-label">备份加密密码</span>
        <input id="configuration-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={disabled} placeholder={savedPassword ? '已记住；留空使用本机保存的密码' : '设置备份密码；恢复时输入原备份的密码'} />
        <span className="field-hint">不同设备恢复时使用同一密码，与 WebDAV 登录密码无关。支持任意非空密码，建议使用较长密码。</span>
      </label>
      <div className="backup-password-options">
        <label className="configuration-choice"><input type="checkbox" checked={rememberPassword} disabled={disabled} onChange={event => setRememberPassword(event.target.checked)} />在本机保险箱记住备份密码</label>
        {savedPassword && <button className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => void run('忘记密码', async () => { setSavedPassword(result(await api.savePassword(''))); setRememberPassword(false); return '已忘记本机保存的备份密码' })}>忘记已保存的密码</button>}
      </div>
      <div className="backup-tabs" role="tablist" aria-label="备份方式">
        <button role="tab" aria-selected={section === 'file'} onClick={() => setSection('file')}>本地文件</button>
        <button role="tab" aria-selected={section === 'webdav'} onClick={() => setSection('webdav')}>WebDAV 云端</button>
      </div>
      <div hidden={section !== 'file'}>
      <p className="field-hint">导出到文件，或将另一台电脑的备份合并到本机。同 ID 更新，相同服务器的不同 ID 默认跳过。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button className="btn" disabled={disabled} onClick={() => void run('导出备份', async () => {
          const saved = result(await api.exportFile(password))
          return saved.cancelled ? '已取消导出' : `加密备份已导出：${saved.path}`
        })}>备份到文件</button>
        <button className="btn" disabled={disabled} onClick={() => void run('导入备份', async () => await imported(result(await api.importFile(password))))}>从文件恢复</button>
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
          <button className="btn" disabled={disabled || !location.serverUrl.trim()} onClick={() => void run('保存 WebDAV', async () => {
            await saveRemote()
            return 'WebDAV 配置已保存；账号密码不会包含在配置备份中'
          })}>保存 WebDAV</button>
          <button className="btn" disabled={remoteDisabled} onClick={() => void run('测试 WebDAV', async () => { await saveRemote(); return result(await api.testWebdav()) })}>测试连接</button>
          <button className="btn btn-primary" disabled={remoteDisabled} onClick={() => void run('上传 WebDAV', async () => {
            await saveRemote()
            const message = result(await api.uploadWebdav(password))
            setConfiguration(result(await api.webdav()))
            return message
          })}>备份到云端</button>
          <button className="btn" disabled={remoteDisabled} onClick={() => void run('下载 WebDAV', async () => { await saveRemote(); return await imported(result(await api.downloadWebdav(password))) })}>从云端恢复</button>
        </div>
        {dirty && <div className="field-hint" style={{ marginTop: 10 }}>测试或同步时会自动保存当前配置。</div>}
        {configuration.lastSync && <div className="field-hint" style={{ marginTop: 10 }}>最近成功同步：{new Date(configuration.lastSync).toLocaleString('zh-CN')}</div>}
      </div>
      {!unlocked && <div className="field-hint" style={{ marginTop: 12 }}>请先解锁保险箱再备份或同步。</div>}
      {busy && <div role="status" className="field-hint" style={{ marginTop: 12 }}>{busy}中，请稍候…</div>}
      {message && <div role={message.ok ? 'status' : 'alert'} style={{ marginTop: 12, fontSize: 12, color: message.ok ? 'var(--text-secondary)' : 'var(--danger)', overflowWrap: 'anywhere', lineHeight: 1.6 }}>{message.text}</div>}
    </div>
  )
}
