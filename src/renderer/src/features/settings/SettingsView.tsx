import { useEffect, useState } from 'react'
import { useApp } from '../../store/app'
import type { VaultMode, VpnConnection, VpnConnectResult } from '@shared/types'
import ConfigurationSync from './ConfigurationSync'
import SoftwareUpdates from './SoftwareUpdates'
import AppearanceSettings from './AppearanceSettings'
import AiSettings from '../ai/AiSettings'
import SettingsSection from './SettingsSection'

export default function SettingsView() {
  const [info, setInfo] = useState<{
    name: string
    version: string
    platform: string
    platformLabel?: string
    osRelease?: string
    arch?: string
    electron: string
    node: string
    chrome?: string
    packaged?: boolean
  } | null>(null)
  const vaultStatus = useApp((s) => s.vaultStatus)
  const setVaultStatus = useApp((s) => s.setVaultStatus)
  const [pwOpen, setPwOpen] = useState(false)
  const [modeDialog, setModeDialog] = useState(false)
  const [vaultMode, setVaultMode] = useState<VaultMode | null>(null)

  /* 系统 VPN */
  const [vpnList, setVpnList] = useState<VpnConnection[]>([])
  const [vpnLoading, setVpnLoading] = useState(true)
  const [vpnBusy, setVpnBusy] = useState<string | null>(null)
  const [vpnMessage, setVpnMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const isWindows = info?.platform === 'win32'

  const loadVpn = async (): Promise<void> => {
    setVpnLoading(true)
    const res = await window.omnidesk.vpn.list()
    setVpnLoading(false)
    if (res.ok) setVpnList(res.data)
    else setVpnMessage({ ok: false, text: res.message })
  }

  /** 执行一次拨号/断开，并把结果反馈到界面 */
  const vpnAction = async (
    fn: () => Promise<{ ok: boolean; data?: VpnConnectResult; message?: string }>
  ): Promise<void> => {
    setVpnMessage(null)
    const res = await fn()
    if (res.ok && res.data) {
      setVpnMessage({ ok: res.data.ok, text: res.data.message })
    } else {
      setVpnMessage({ ok: false, text: res.message ?? '操作失败' })
    }
    await loadVpn()
  }

  useEffect(() => {
    void loadVpn()
  }, [])

  useEffect(() => {
    void window.omnidesk.app.info().then((r) => {
      if (r.ok) setInfo(r.data)
    })
    void window.omnidesk.vault.getMode().then((r) => {
      if (r.ok) setVaultMode(r.data)
    })
  }, [])

  const lock = async () => {
    const res = await window.omnidesk.vault.lock()
    if (res.ok) setVaultStatus(res.data)
  }

  return (
    <div className="pane settings-page">
      <div className="pane-narrow">
        <header className="settings-page-heading"><h1>设置</h1><p>按需展开分组，查看和调整设置。</p></header>

        <SettingsSection id="appearance" title="外观与字体" description="主题、界面缩放、SSH 终端与连接目录样式">
          <AppearanceSettings embedded />
        </SettingsSection>
        <SettingsSection id="ai" title="AI 模型配置" description="接口、模型、调用上限与默认权限">
          <AiSettings embedded />
        </SettingsSection>
        <SettingsSection id="backup" title="配置备份与 WebDAV 同步" description="加密备份、导入恢复与 WebDAV 同步">
          <ConfigurationSync embedded />
        </SettingsSection>
        <SettingsSection id="updates" title="软件更新" description="版本检查、更新来源与自动检查偏好">
          <SoftwareUpdates embedded />
        </SettingsSection>

        {/* 安全 */}
        <SettingsSection id="security" title="凭据保护" description="本机加密方式、主密码与锁定">
          <div className="card">
            <div className="card-desc">
              服务器密码使用主密码派生的密钥加密后保存在本机。
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 0',
                borderTop: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5 }}>
                  当前方式：
                  <strong>
                    {vaultMode === 'deviceKey'
                      ? '免密码（本机密钥）'
                      : vaultMode === 'masterPassword'
                        ? '主密码'
                        : '未初始化'}
                  </strong>
                </div>
                <div className="field-hint" style={{ marginTop: 3 }}>
                  {vaultMode === 'deviceKey'
                    ? '启动直接进入，无需输入密码。能防配置被拷走泄密，但不防本机被读取。'
                    : '每次启动需要输入主密码。配置文件被拷到别的机器也解不开。'}
                </div>
              </div>
              <button className="btn btn-sm" onClick={() => setModeDialog(true)}>
                切换方式
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              {vaultMode === 'masterPassword' && (
                <button className="btn" onClick={() => setPwOpen(true)}>
                  修改主密码
                </button>
              )}
              <button className="btn" onClick={lock}>
                立即锁定
              </button>
            </div>

            <div className="alert alert-info" style={{ marginTop: 14 }}>
              <span>ℹ</span>
              <div>
                本应用不会关闭 TLS 证书校验，也不会忽略安全策略。
                连接自签名证书的服务器时，请在该连接的配置里单独开启「忽略证书错误」，
                而不要期望全局放宽 —— 全局放宽会让所有连接（包括 AI 服务调用）都失去保护。
              </div>
            </div>
          </div>
        </SettingsSection>

        {/* 系统 VPN */}
        <SettingsSection id="vpn" title="系统 VPN" description="查看 Windows VPN 状态，手动连接或断开">
          <div className="card">
            <div className="card-desc">
              这里是 Windows「设置 → 网络和 Internet → VPN」里已配置的连接。
              <strong>VPN 是系统级的</strong> —— 拨通后本程序的所有连接都会走它，
              无需额外配置。如果只想让某一条连接走特定出口，请在连接的「网络代理」里设置。
            </div>

            {vpnLoading ? (
              <div className="field-hint">正在读取系统 VPN 列表…</div>
            ) : vpnList.length === 0 ? (
              <div className="alert alert-info">
                <span>ℹ</span>
                <div>
                  系统里没有已配置的 VPN 连接。
                  {isWindows
                    ? '如需添加，请到 Windows 的「设置 → 网络和 Internet → VPN」中新建。'
                    : '系统 VPN 集成目前仅支持 Windows。'}
                </div>
              </div>
            ) : (
              <>
                {vpnList.map((v) => (
                  <div
                    key={v.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '9px 0',
                      borderTop: '1px solid var(--border)'
                    }}
                  >
                    <span className={`dot ${v.connected ? 'dot-connected' : 'dot-idle'}`} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12.5 }}>{v.name}</div>
                      <div className="field-hint">{v.connected ? '已连接' : '未连接'}</div>
                    </div>
                    {v.connected ? (
                      <button
                        className="btn btn-sm"
                        disabled={vpnBusy === v.name}
                        onClick={() => vpnAction(() => window.omnidesk.vpn.disconnect(v.name))}
                      >
                        {vpnBusy === v.name ? '处理中…' : '断开'}
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={vpnBusy === v.name}
                        onClick={() => vpnAction(() => window.omnidesk.vpn.connect(v.name))}
                      >
                        {vpnBusy === v.name ? '拨号中…' : '连接'}
                      </button>
                    )}
                  </div>
                ))}

                {vpnMessage && (
                  <div
                    className={`alert ${vpnMessage.ok ? 'alert-info' : 'alert-danger'}`}
                    style={{ marginTop: 12 }}
                  >
                    <span>{vpnMessage.ok ? '✓' : '⚠'}</span>
                    <div>{vpnMessage.text}</div>
                  </div>
                )}
              </>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-sm" onClick={() => void loadVpn()}>
                刷新状态
              </button>
            </div>

            <div className="field-hint" style={{ marginTop: 12, lineHeight: 1.7 }}>
              拨号默认使用 Windows 已保存的账号密码（推荐）。
              这是有意为之 —— 命令行传密码会出现在系统进程列表里，不安全。
            </div>
          </div>
        </SettingsSection>

        {/* 快捷键 */}
        <SettingsSection id="shortcuts" title="快捷键" description="新建连接、搜索与标签切换快捷键">
          <div className="card">
            <table className="table" style={{ marginTop: 8 }}>
              <tbody>
                {[
                  ['新建连接', 'Ctrl + N'],
                  ['快速搜索', 'Ctrl + K'],
                  ['关闭当前标签', 'Ctrl + W'],
                  ['切换标签', 'Ctrl + Tab'],
                  ['复制', 'Ctrl + Shift + C'],
                  ['粘贴', 'Ctrl + Shift + V']
                ].map(([label, keys]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td style={{ textAlign: 'right' }}>
                      <kbd>{keys}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsSection>

        {/* 关于 */}
        <SettingsSection id="about" title="关于" description="应用版本、系统信息与开源组件">
          <div className="card">
            <div className="card-desc" style={{ marginBottom: 12 }}>
              连接 Windows 与 Linux，并把能力开放给 AI 与其他系统
            </div>
            {info && (
              <table className="table">
                <tbody>
                  <tr>
                    <td style={{ color: 'var(--text-secondary)' }}>版本</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {info.version}
                      {info.packaged ? '' : ' （开发模式）'}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: 'var(--text-secondary)' }}>系统平台</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {info.platformLabel ?? info.platform}
                    </td>
                  </tr>
                  {info.osRelease && (
                    <tr>
                      <td style={{ color: 'var(--text-secondary)' }}>系统版本</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {info.osRelease}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ color: 'var(--text-secondary)' }}>Electron</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {info.electron}
                    </td>
                  </tr>
                  {info.chrome && (
                    <tr>
                      <td style={{ color: 'var(--text-secondary)' }}>Chromium</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {info.chrome}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ color: 'var(--text-secondary)' }}>Node</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {info.node}
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            <div className="field-hint" style={{ marginTop: 12 }}>
              <div>Windows x64 内置远程桌面基于 FreeRDP（Apache-2.0）。</div>
              <div>IronRDP（Devolutions，MIT OR Apache-2.0）保留用于兼容平台与凭据测试。</div>
              <div>终端由 xterm.js 提供。SSH 由 ssh2 提供。</div>
            </div>
          </div>
        </SettingsSection>
      </div>

      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}

      {modeDialog && (
        <ModeSwitchDialog
          current={vaultMode}
          onClose={() => setModeDialog(false)}
          onDone={(next) => {
            setVaultMode(next)
            setModeDialog(false)
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * 切换凭据保护方式
 *
 * 两个方向都只是重新包裹数据密钥，与存了多少凭据无关，操作是瞬时的。
 * 往「免密码」方向是安全降级，必须让用户明确确认。
 */
function ModeSwitchDialog({
  current,
  onClose,
  onDone
}: {
  current: VaultMode | null
  onClose: () => void
  onDone: (next: VaultMode) => void
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [understood, setUnderstood] = useState(false)

  const toMaster = current === 'deviceKey'

  const submit = async () => {
    setError('')

    if (toMaster) {
      if (newPw.length < 8) return setError('主密码至少 8 位')
      if (newPw !== newPw2) return setError('两次输入不一致')
    } else {
      if (!understood) return setError('请先确认你了解这样做的影响')
    }

    setBusy(true)
    try {
      const res = await window.omnidesk.vault.setMode(toMaster ? 'masterPassword' : 'deviceKey', {
        currentPassword: current === 'masterPassword' ? currentPw : undefined,
        newPassword: toMaster ? newPw : undefined
      })
      if (!res.ok) {
        setError(res.message)
        return
      }
      onDone(toMaster ? 'masterPassword' : 'deviceKey')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{toMaster ? '设置主密码' : '改为免密码'}</h2>
        </div>

        <div className="modal-body">
          {toMaster ? (
            <>
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                <span>ℹ</span>
                <div>
                  设置后，每次启动都需要输入主密码。凭据会改用这个密码保护的密钥加密。
                  现有凭据会自动保留，不需要重新录入。
                </div>
              </div>

              <div className="field">
                <span className="field-label">新主密码</span>
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="field">
                <span className="field-label">确认新主密码</span>
                <input type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
              </div>

              <div className="alert alert-warning">
                <span>⚠</span>
                <div>
                  <strong>请务必记住这个密码。</strong>
                  它不会被记录在任何地方，忘记后已保存的服务器密码将无法恢复。
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="alert alert-warning" style={{ marginBottom: 14 }}>
                <span>⚠</span>
                <div>
                  <strong>这会降低凭据的安全等级。</strong>
                  <div style={{ marginTop: 6, lineHeight: 1.7 }}>
                    改为免密码后，加密密钥会改为本机生成的密钥文件。这意味着：
                    <div style={{ marginTop: 4 }}>✅ 配置文件被拷到别的机器，仍然解不开</div>
                    <div>❌ 能读取你电脑上文件的人或程序，可以解开这些凭据</div>
                  </div>
                </div>
              </div>

              <div className="field">
                <span className="field-label">当前主密码</span>
                <input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  placeholder="用于确认是你本人操作"
                  autoFocus
                />
              </div>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border)',
                  cursor: 'pointer'
                }}
              >
                <input
                  type="checkbox"
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                  style={{ width: 'auto', marginTop: 3 }}
                />
                <span style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                  我了解这样做的影响，并接受这个安全等级
                </span>
              </label>
            </>
          )}

          {error && (
            <div className="alert alert-danger" style={{ marginTop: 14 }}>
              {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || (!toMaster && !understood)}
          >
            {busy ? '处理中…' : toMaster ? '设置主密码' : '确认改为免密码'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError('')
    if (newPw.length < 8) return setError('新密码至少 8 位')
    if (newPw !== confirm) return setError('两次输入不一致')

    setBusy(true)
    const res = await window.omnidesk.vault.changePassword(oldPw, newPw)
    setBusy(false)
    if (!res.ok) return setError(res.message)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">修改主密码</h2>
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">当前主密码</span>
            <input
              type="password"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <span className="field-label">新主密码</span>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </div>
          <div className="field">
            <span className="field-label">确认新主密码</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {error && <div className="alert alert-danger">{error}</div>}
          <div className="field-hint" style={{ marginTop: 10 }}>
            修改主密码不会重新加密已有数据 —— 只是换一层包裹，
            所以无论存了多少凭据都是瞬间完成。
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? '处理中…' : '确认修改'}
          </button>
        </div>
      </div>
    </div>
  )
}
