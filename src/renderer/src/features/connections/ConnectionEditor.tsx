import ActionButton from '../../components/ActionButton'
import { useEffect, useRef, useState } from 'react'
import TagInput, { type TagInputHandle } from '../../components/TagInput'
import { useApp } from '../../store/app'
import { connectionKey, formatConnectionAddress, parseConnectionAddress } from '@shared/connection-identity'
import { RDP_PERFORMANCE_MODES } from '@shared/rdp-display'
import type {
  Connection,
  LocalSshKey,
  ProxyType,
  RdpConnection,
  RdpOptions,
  SharedCredential,
  SshConnection
} from '@shared/types'

interface Props {
  connectionId: string | null
  initialKind?: DraftKind
  onClose: () => void
}

type DraftKind = 'ssh' | 'rdp'

/**
 * 连接编辑器
 *
 * 一个表单同时服务 SSH 和 RDP 两种类型 —— 切换类型时
 * 共有的字段（名称/主机/端口/用户名）保留，类型特有的字段各自维护。
 */
export default function ConnectionEditor({ connectionId, initialKind = 'ssh', onClose }: Props) {
  const connections = useApp((s) => s.connections)
  const setConnections = useApp((s) => s.setConnections)

  const editing = connectionId ? connections.find((c) => c.id === connectionId) : undefined

  const [kind, setKind] = useState<DraftKind>(editing?.kind ?? initialKind)
  const [name, setName] = useState(editing?.name ?? '')
  const [host, setHost] = useState(editing?.host ?? '')
  const [port, setPort] = useState(String(editing?.port ?? (initialKind === 'rdp' ? 3389 : 22)))
  const [username, setUsername] = useState(
    editing && 'username' in editing ? editing.username : ''
  )
  const [group, setGroup] = useState(editing?.group ?? '')
  const [note, setNote] = useState(editing?.note ?? '')
  const [tags, setTags] = useState<string[]>(editing?.tags ?? [])
  const tagInput = useRef<TagInputHandle>(null)

  const duplicate = connections.find(item => item.id !== connectionId && connectionKey(item) === connectionKey({ kind, host, port: Number(port) }))

  // 认证
  const [authMethod, setAuthMethod] = useState<SshConnection['authMethod']>(
    editing?.kind === 'ssh' ? editing.authMethod : 'password'
  )
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [credential, setCredential] = useState('')

  // 私钥选择（一键扫描本机）
  const [localKeys, setLocalKeys] = useState<LocalSshKey[]>([])
  const [keyListOpen, setKeyListOpen] = useState(false)
  const [keyScanning, setKeyScanning] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState('')

  // 公共凭据（多台机器共用一个密码时用）
  const [sharedCredentialList, setSharedCredentialList] = useState<SharedCredential[]>([])
  const [sharedCredentialId, setSharedCredentialId] = useState(
    (editing as { sharedCredentialId?: string } | undefined)?.sharedCredentialId ?? ''
  )

  // 打开编辑器时拉一次公共凭据列表
  useEffect(() => {
    void window.omnidesk.shared.list().then((r) => {
      if (r.ok) setSharedCredentialList(r.data)
    })
  }, [])

  // RDP 特有
  const windowsDesktop = navigator.platform.startsWith('Win')
  const [rdpEngine, setRdpEngine] = useState<NonNullable<RdpOptions['engine']>>(windowsDesktop ? 'freerdp' : editing?.kind === 'rdp' ? editing.options?.engine ?? 'ironrdp' : 'ironrdp')
  const [securityMode, setSecurityMode] = useState<NonNullable<RdpOptions['securityMode']>>(editing?.kind === 'rdp' ? editing.options?.securityMode ?? 'auto' : 'auto')
  const [nativeStatus, setNativeStatus] = useState<{ available: boolean; message: string }>()
  useEffect(() => {
    let cancelled = false
    void window.omnidesk.rdp.nativeStatus?.().then(result => { if (!cancelled && result.ok) setNativeStatus(result.data) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const [domain, setDomain] = useState(editing?.kind === 'rdp' ? (editing.domain ?? '') : '')
  const [performanceMode, setPerformanceMode] = useState<RdpOptions['performanceMode']>(editing?.kind === 'rdp' ? editing.options?.performanceMode : 'balanced')
  const [dynamicResolution, setDynamicResolution] = useState(editing?.kind === 'rdp' ? editing.options?.dynamicResolution !== false : true)
  const [fullscreen, setFullscreen] = useState(editing?.kind === 'rdp' ? editing.options?.fullscreen === true : false)
  const [systemSmartSizing, setSystemSmartSizing] = useState(editing?.kind === 'rdp' ? editing.options?.systemSmartSizing ?? (editing.options?.performanceMode === 'smooth' || editing.options?.performanceMode === 'balanced') : true)
  const [enableClipboard, setEnableClipboard] = useState(editing?.kind === 'rdp' ? editing.options?.enableClipboard !== false : true)
  const [ignoreCertificate, setIgnoreCertificate] = useState(editing?.kind === 'rdp' ? editing.options?.ignoreCertificate !== false : true)

  // 代理（按连接独立配置）
  const [proxyType, setProxyType] = useState<ProxyType>(editing?.proxy?.type ?? 'none')
  const [proxyHost, setProxyHost] = useState(editing?.proxy?.host ?? '')
  const [proxyPort, setProxyPort] = useState(
    editing?.proxy?.port ? String(editing.proxy.port) : ''
  )
  const [proxyUser, setProxyUser] = useState(editing?.proxy?.username ?? '')
  const [proxyPass, setProxyPass] = useState(editing?.proxy?.password ?? '')
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyTestResult, setProxyTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [addressError, setAddressError] = useState('')
  const savedCheck = useApp(state => connectionId ? state.connectionChecks[connectionId] : undefined)
  const selectedCredential = sharedCredentialList.find((item) => item.id === sharedCredentialId)
  const compatibleCredentials = sharedCredentialList.filter((item) => kind === 'rdp' ? item.kind === 'password' : true)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving && !keyListOpen) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving, keyListOpen])

  // 切换类型时自动调整默认端口
  useEffect(() => {
    if (editing) return
    setPort(current => current === '22' || current === '3389' ? kind === 'rdp' ? '3389' : '22' : current)
  }, [kind, editing])

  // 切换代理类型时给个合理的默认端口
  useEffect(() => {
    if (editing?.proxy?.port) return
    if (proxyType === 'socks5' || proxyType === 'socks4') setProxyPort('1080')
    else if (proxyType === 'http') setProxyPort('8080')
    else setProxyPort('')
  }, [proxyType, editing])

  /** 当前表单里的代理配置（用于保存与测试） */
  const currentProxy = () => {
    if (proxyType === 'none') return undefined
    const p = Number(proxyPort)
    if (!proxyHost.trim()) throw new Error('请填写代理服务器地址')
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('代理端口需为 1 - 65535 之间的整数')
    return {
      type: proxyType,
      host: proxyHost.trim(),
      port: p,
      username: proxyUser.trim() || undefined,
      password: proxyPass || undefined
    }
  }

  const testProxy = async () => {
    setProxyTestResult(null)
    let proxy
    let endpoint
    try {
      proxy = currentProxy()
      endpoint = parseConnectionAddress(host, Number(port))
    } catch (e) {
      setProxyTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) })
      return
    }
    if (!proxy) {
      setProxyTestResult({ ok: false, msg: '未选择代理类型' })
      return
    }
    if (!host.trim()) {
      setProxyTestResult({ ok: false, msg: '请先填写目标主机地址' })
      return
    }

    setProxyTesting(true)
    const res = await window.omnidesk.proxy.test(proxy, endpoint.host, endpoint.port)
    setProxyTesting(false)
    if (res.ok) {
      setProxyTestResult({ ok: true, msg: `已通过代理连通 ${formatConnectionAddress(endpoint.host, endpoint.port)}` })
    } else {
      setProxyTestResult({ ok: false, msg: res.message })
    }
  }

  /** 从指定路径读入私钥内容 */
  const loadKeyFrom = async (filePath: string): Promise<void> => {
    setKeyError('')
    const res = await window.omnidesk.app.readTextFile(filePath)
    if (!res.ok) {
      setKeyError(`读取私钥失败：${res.message}`)
      return
    }
    setPrivateKeyPath(filePath)
    setCredential(res.data)
    setError('')
  }

  const save = async () => {
    if (saving) return
    setError('')
    if (!name.trim()) return setError('请填写名称')
    if (!host.trim()) return setError('请填写主机地址')
    try { parseConnectionAddress(host, Number(port)) }
    catch (error) { return setError(error instanceof Error ? error.message : String(error)) }
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return setError('服务端口必须为 1–65535 之间的整数')
    if (sharedCredentialId && !selectedCredential) return setError('选择的公共凭据不存在，请重新选择')

    setSaving(true)
    try {
      // 代理配置对所有连接类型通用
      let proxy
      try {
        proxy = currentProxy()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setSaving(false)
        return
      }

      const base = {
        ...editing,
        id: editing?.id,
        kind,
        name: name.trim(),
        host: host.trim(),
        port: Number(port),
        group: group.trim() || undefined,
        note: note.trim() || undefined,
        tags: tagInput.current?.read() ?? tags,
        username: username.trim() || selectedCredential?.username || '',
        proxy,
        // 选了公共凭据就记下来；留空表示本连接自己填
        sharedCredentialId: sharedCredentialId || undefined,
        credentialRef: editing && 'credentialRef' in editing ? editing.credentialRef : undefined,
        createdAt: editing?.createdAt ?? Date.now(),
        updatedAt: Date.now()
      } as Partial<Connection> & { kind: DraftKind }

      let payload: Connection
      if (kind === 'ssh') {
        payload = {
          ...base,
          kind: 'ssh',
          authMethod: selectedCredential?.kind ?? authMethod
        } as SshConnection
      } else {
        payload = {
          ...base,
          kind: 'rdp',
          domain: domain.trim() || undefined,
          options: {
            ...(editing?.kind === 'rdp' ? editing.options : {}),
            engine: rdpEngine,
            securityMode: rdpEngine === 'freerdp' ? securityMode : 'auto',
            performanceMode,
            dynamicResolution,
            fullscreen,
            systemSmartSizing,
            enableClipboard,
            ignoreCertificate
          }
        } as RdpConnection
      }

      // 私钥认证时：secret 是私钥内容，passphrase 是口令 —— 两者必须分开存，
      // 早期版本共用一个字段，导致填了口令就把私钥内容冲掉了
      const isKey = kind === 'ssh' && authMethod === 'privateKey'
      const cred =
        !sharedCredentialId && (credential.length > 0 || privateKeyPassphrase.length > 0)
          ? {
              secret: credential,
              passphrase: isKey ? privateKeyPassphrase || undefined : undefined
            }
          : undefined

      const result = await window.omnidesk.connections.save(payload, cred)
      if (!result.ok) {
        setError(result.message)
        return
      }

      const current = useApp.getState().connections
      setConnections(current.some((item) => item.id === result.data.id)
        ? current.map((item) => item.id === result.data.id ? result.data : item)
        : [...current, result.data])
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存连接失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!editing) return
    if (!confirm(`确定删除连接「${editing.name}」？该操作不可撤销。`)) return
    const result = await window.omnidesk.connections.remove(editing.id)
    if (result.ok) {
      const list = await window.omnidesk.connections.list()
      if (list.ok) setConnections(list.data)
      onClose()
    }
  }

  const groups = [...new Set(connections.map((c) => c.group).filter(Boolean))] as string[]

  return (
    <div className="modal-backdrop" onClick={(e) => !saving && e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg connection-editor" role="dialog" aria-modal="true" aria-label={editing ? '编辑连接' : '新建连接'}>
        <div className="modal-header">
          <h2 className="modal-title">{editing ? '编辑连接' : '新建连接'}</h2>
          <button className="btn btn-ghost btn-icon" aria-label="关闭编辑器" disabled={saving} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {!!savedCheck?.issues.length && <div className="alert alert-warning">此连接待完善：{savedCheck.issues.join('；')}。</div>}
          <div className="field">
            <span className="field-label">连接类型</span>
            <div className="segmented">
              <button disabled={!!editing} data-active={kind === 'ssh'} onClick={() => { setKind('ssh'); setSharedCredentialId('') }}>
                SSH · Linux
              </button>
              <button disabled={!!editing} data-active={kind === 'rdp'} onClick={() => { setKind('rdp'); setSharedCredentialId('') }}>
                RDP · Windows
              </button>
            </div>
          </div>

          <div className="field">
            <span className="field-label">名称</span>
            <input
              value={name}
              aria-label="连接名称"
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'rdp' ? '生产环境 Windows Server' : '测试机 · 上海'}
              autoFocus
            />
          </div>

          <div className="field-row">
            <div className="field">
              <span className="field-label">主机地址</span>
              <input
                value={host}
                aria-label="主机地址"
                onChange={(e) => { setHost(e.target.value); setAddressError('') }}
                onBlur={() => {
                  if (!host.trim()) return
                  try {
                    parseConnectionAddress(host, Number(port))
                    setAddressError('')
                  } catch (error) { setAddressError(error instanceof Error ? error.message : String(error)) }
                }}
                aria-invalid={!!addressError}
                aria-describedby="connection-address-hint"
                placeholder="192.0.2.10:9101 或 example.com"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <span className="field-label">端口</span>
              <input
                value={port}
                aria-label="端口"
                onChange={(e) => { setPort(e.target.value); setAddressError('') }}
                placeholder={kind === 'rdp' ? '3389' : '22'}
                spellCheck={false}
              />
            </div>
          </div>

          <div id="connection-address-hint" className={`field-hint connection-address-hint${addressError ? ' connection-address-error' : ''}`}>
            {addressError || '支持 IP:端口，按原样保存。地址自带端口时，连接使用该穿透入口；右侧服务端口保留。IPv6 可用 [地址]:端口。'}
          </div>

          <div className="field-row">
            <div className="field">
              <span className="field-label">用户名</span>
              <input
                value={selectedCredential?.username || username}
                aria-label="用户名"
                disabled={!!selectedCredential?.username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={selectedCredential?.username || (kind === 'rdp' ? 'Administrator' : 'root')}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <span className="field-label">分组（可选）</span>
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="生产环境"
                list="group-options"
              />
              <datalist id="group-options">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
          </div>

          {kind === 'rdp' && (
            <div className="field">
              <span className="field-label">域（可选）</span>
              <input
                value={domain}
                disabled={!!selectedCredential?.domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder={selectedCredential?.domain || '留空则使用本地账户'}
                spellCheck={false}
              />
            </div>
          )}

          {/* 公共凭据：多台机器共用一个密码时，这里选一下就行 */}
          <div className="field">
            <div className="field-label-row">
              <span className="field-label">凭据来源</span>
              <button className="text-link" onClick={() => {
                useApp.getState().openTab({ id: 'tab-credentials', kind: 'credentials', title: '公共凭据', status: 'idle' })
                onClose()
              }}>管理公共凭据 ↗</button>
            </div>
            <select
              aria-label="凭据来源"
              value={sharedCredentialId}
              onChange={(e) => {
                setSharedCredentialId(e.target.value)
                const item = sharedCredentialList.find((entry) => entry.id === e.target.value)
                if (item && kind === 'ssh') setAuthMethod(item.kind)
              }}
            >
              <option value="">本连接单独填写</option>
              {compatibleCredentials.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.kind === 'privateKey' ? '（私钥）' : '（密码）'}
                </option>
              ))}
            </select>
            <span className="field-hint">
              {sharedCredentialId
                ? `使用公共凭据${selectedCredential?.username ? ` · 共享账号 ${selectedCredential.username}` : ''}。修改后，下次连接时统一生效；当前会话不受影响。`
                : sharedCredentialList.length > 0
                  ? '多台服务器共用账号、密码或私钥？选择一条公共凭据，只需维护一份。'
                  : '还没有公共凭据。点击「管理公共凭据」创建共享账号、密码或 SSH 私钥。'}
            </span>
          </div>

          {kind === 'ssh' && !sharedCredentialId && (
            <div className="field">
              <span className="field-label">认证方式</span>
              <div className="segmented">
                <button data-active={authMethod === 'password'} onClick={() => setAuthMethod('password')}>
                  密码
                </button>
                <button
                  data-active={authMethod === 'privateKey'}
                  onClick={() => setAuthMethod('privateKey')}
                >
                  私钥
                </button>
                <button data-active={authMethod === 'agent'} onClick={() => setAuthMethod('agent')}>
                  SSH Agent
                </button>
              </div>
            </div>
          )}

          {kind === 'ssh' && authMethod === 'privateKey' && !sharedCredentialId && (
            <div className="field">
              <span className="field-label">私钥</span>

              {/* 一键选择：扫描本机私钥，省得用户自己去翻 .ssh 目录 */}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn"
                  onClick={async () => {
                    setKeyError('')
                    setKeyScanning(true)
                    const res = await window.omnidesk.app.scanSshKeys()
                    setKeyScanning(false)
                    if (!res.ok) {
                      setKeyError(res.message)
                      return
                    }
                    setLocalKeys(res.data)
                    setKeyListOpen(true)
                  }}
                  disabled={keyScanning}
                >
                  {keyScanning ? '扫描中…' : '从本机选择'}
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const picked = await pickFile()
                    if (!picked) return
                    await loadKeyFrom(picked)
                  }}
                >
                  浏览文件…
                </button>
                {privateKeyPath && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: 'var(--text-tertiary)',
                      alignSelf: 'center',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 160
                    }}
                    title={privateKeyPath}
                  >
                    {privateKeyPath.split(/[\\/]/).pop()}
                  </span>
                )}
              </div>

              {keyError && <div className="field-hint" style={{ color: 'var(--danger)' }}>{keyError}</div>}

              {keyListOpen && (
                <LocalKeyPicker
                  keys={localKeys}
                  onPick={async (k) => {
                    setKeyListOpen(false)
                    await loadKeyFrom(k.path)
                  }}
                  onClose={() => setKeyListOpen(false)}
                />
              )}

              {credential && !keyError && (
                <span className="field-hint">
                  私钥已读入（{credential.length} 字节），保存后将加密存储在主密码保护的保险箱中
                </span>
              )}
              {privateKeyPassphrase.length > 0 && (
                <span className="field-hint">已填写口令</span>
              )}
            </div>
          )}

          {!sharedCredentialId && (kind === 'rdp' || (kind === 'ssh' && authMethod !== 'agent')) && (
            <div className="field">
              <span className="field-label">
                {kind === 'rdp'
                  ? '密码'
                  : authMethod === 'privateKey'
                    ? '私钥口令（私钥没加密就留空）'
                    : '密码'}
              </span>
              {kind === 'ssh' && authMethod === 'privateKey' ? (
                // 私钥认证：这里填的是口令，私钥内容在上一栏单独管理
                <input
                  type="password"
                  value={privateKeyPassphrase}
                  onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
                  placeholder={editing ? '留空则保持原口令不变' : '私钥未加密可留空'}
                  autoComplete="off"
                />
              ) : (
                <input
                  type="password"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  placeholder={editing ? '留空则保持原凭据不变' : '输入密码'}
                  autoComplete="off"
                />
              )}
              <span className="field-hint">
                账号或凭据可以稍后补充，未配置完整的连接会显示“待完善”。凭据加密保存在本机保险箱。
              </span>
            </div>
          )}

          {kind === 'rdp' && (
            <>
              <div className="field" style={{ marginTop: 18 }}>
                <label className="field-label" htmlFor="rdp-engine">内置桌面引擎</label>
                <select id="rdp-engine" className="input" value={rdpEngine} onChange={event => setRdpEngine(event.target.value as NonNullable<RdpOptions['engine']>)}>
                  {!windowsDesktop && <option value="ironrdp">IronRDP</option>}
                  <option value="freerdp">FreeRDP · Windows 默认引擎</option>
                </select>
                <span className="field-hint">Windows 内置桌面统一使用本机 FreeRDP，在当前标签页显示；连接从本机直达目标，系统客户端仍可使用。</span>
                {rdpEngine === 'freerdp' && <span className="field-hint" role="status">{nativeStatus?.message ?? '正在检查 FreeRDP 运行库…'}</span>}
              </div>
              {rdpEngine === 'freerdp' && <div className="field">
                <label className="field-label" htmlFor="rdp-security">安全协商</label>
                <select id="rdp-security" className="input" value={securityMode} onChange={event => setSecurityMode(event.target.value as NonNullable<RdpOptions['securityMode']>)}>
                  <option value="auto">TLS / NLA 优先 · 旧服务器确认后兼容</option>
                  <option value="legacy">旧版 RDP 安全层 · 仅可信旧服务器</option>
                </select>
                <span className="field-hint">先使用 TLS / NLA；仅确认服务器只接受旧版安全层时提示，用户同意后自动重连并只保存此服务器。证书、账号、网络错误不会触发降级。旧版模式不使用 TLS / NLA，首次使用需确认；请勿关闭服务器 NLA。</span>
              </div>}
              <div className="field-label" style={{ marginTop: 18, marginBottom: 10 }}>
                显示与设备
              </div>
              <div className="field rdp-performance-field">
                <span className="field-label">画质与流畅度</span>
                <div className="rdp-performance-modes" role="group" aria-label="RDP 画质模式">
                  {RDP_PERFORMANCE_MODES.map(mode => <button type="button" key={mode.value} className="rdp-performance-mode" aria-pressed={performanceMode === mode.value} onClick={() => { setPerformanceMode(mode.value); setSystemSmartSizing(mode.value !== 'clear') }}>
                    <strong>{mode.label}</strong><span>{mode.limit}</span>
                  </button>)}
                </div>
                <span className="field-hint" role="status">{RDP_PERFORMANCE_MODES.find(mode => mode.value === performanceMode)?.description ?? '当前保留旧版参数；选择一种模式后，软件会自动配置，下次连接生效。'}</span>
                <details className="field-hint"><summary>自动配置说明 · 下次连接生效</summary><p>内置桌面按窗口比例调整分辨率，不超过模式上限；系统客户端还会自动调整色深、字体平滑和桌面特效。流畅 / 均衡的系统客户端固定分辨率并缩放窗口，避免放大后又变卡；需要原生像素请选择清晰。</p></details>
              </div>
              <ToggleRow
                label="自适应分辨率"
                desc="内置桌面随窗口调整远端分辨率，遵守所选模式上限；系统客户端仅清晰 / 旧版参数使用动态分辨率，取决于目标支持"
                value={dynamicResolution}
                onChange={setDynamicResolution}
              />
              <ToggleRow
                label="系统客户端全屏启动"
                desc="在当前显示器全屏，分辨率遵守所选模式上限；按 Ctrl + Alt + Break 切换全屏与窗口"
                value={fullscreen}
                onChange={setFullscreen}
              />
              <ToggleRow
                label="系统客户端适应窗口（缩放画面）"
                desc="流畅 / 均衡默认开启，清晰默认关闭。缩放可能使文字稍模糊；关闭后优先原生像素，小窗口可能出现滚动条"
                value={systemSmartSizing}
                onChange={setSystemSmartSizing}
              />
              <ToggleRow
                label="剪贴板重定向"
                desc="在本机与远端之间同步复制的文本"
                value={enableClipboard}
                onChange={setEnableClipboard}
              />
              <ToggleRow
                label="忽略证书错误"
                desc={rdpEngine === 'freerdp' && securityMode === 'legacy' ? '旧版安全层不使用 TLS，此设置在该模式下不生效；返回 TLS / NLA 模式后恢复此选项。' : '默认开启；会跳过服务器证书校验。需要严格验证服务器身份时请关闭，不影响 NLA 认证'}
                value={ignoreCertificate}
                onChange={setIgnoreCertificate}
                danger
              />
            </>
          )}

          {/* 代理：按连接独立配置，不影响其他连接 */}
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <div className="field">
              <span className="field-label">网络代理</span>
              <div className="segmented" style={{ flexWrap: 'wrap' }}>
                {(
                  [
                    ['none', '不使用'],
                    ['socks5', 'SOCKS5'],
                    ['socks4', 'SOCKS4'],
                    ['http', 'HTTP']
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} data-active={proxyType === v} onClick={() => setProxyType(v)}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="field-hint">
                只影响这一条连接，其他连接不受影响。想让流量从服务器出去（以服务器为出口），
                请改用「端口转发 → 动态转发」。
              </span>
            </div>

            {proxyType !== 'none' && (
              <>
                <div className="field-row">
                  <div className="field">
                    <span className="field-label">代理地址</span>
                    <input
                      value={proxyHost}
                      onChange={(e) => setProxyHost(e.target.value)}
                      placeholder="127.0.0.1"
                      spellCheck={false}
                    />
                  </div>
                  <div className="field">
                    <span className="field-label">端口</span>
                    <input
                      value={proxyPort}
                      onChange={(e) => setProxyPort(e.target.value)}
                      placeholder={proxyType === 'http' ? '8080' : '1080'}
                      spellCheck={false}
                    />
                  </div>
                </div>

                <div className="field-row">
                  <div className="field">
                    <span className="field-label">用户名（可选）</span>
                    <input
                      value={proxyUser}
                      onChange={(e) => setProxyUser(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <span className="field-label">密码（可选）</span>
                    <input
                      type="password"
                      value={proxyPass}
                      onChange={(e) => setProxyPass(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button className="btn btn-sm" onClick={testProxy} disabled={proxyTesting}>
                    {proxyTesting ? '测试中…' : '测试连通性'}
                  </button>
                  {proxyTestResult && (
                    <span
                      style={{
                        fontSize: 12,
                        color: proxyTestResult.ok ? 'var(--success)' : 'var(--danger)',
                        lineHeight: 1.5
                      }}
                    >
                      {proxyTestResult.ok ? '✓ ' : '✕ '}
                      {proxyTestResult.msg}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>

          {duplicate && <div className="alert alert-warning">此服务器已存在：{duplicate.name}。保存时需要确认是否新增重复连接。</div>}
          <TagInput ref={tagInput} value={tags} onChange={setTags} suggestions={connections.flatMap(item => item.tags ?? [])} />
          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">备注（显示在列表中）</span>
            <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="用途、负责人、维护注意事项；支持搜索" />
          </div>

          {error && <div className="alert alert-danger">{error}</div>}
        </div>

        <div className="modal-footer">
          {editing && (
            <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}>
              删除
            </button>
          )}
          <button className="btn" disabled={saving} onClick={onClose}>
            取消
          </button>
          <ActionButton phase={saving ? 'busy' : 'idle'} icon="check" className="btn btn-primary" onClick={save} disabled={saving}>
            保存
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ToggleRow({
  label,
  desc,
  value,
  onChange,
  danger
}: {
  label: string
  desc: string
  value: boolean
  onChange: (v: boolean) => void
  danger?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '9px 0',
        borderTop: '1px solid var(--border)'
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 450, color: danger ? 'var(--danger)' : undefined }}>
          {label}
        </div>
        <div className="field-hint" style={{ marginTop: 2 }}>
          {desc}
        </div>
      </div>
      <button className="switch" role="switch" aria-checked={value} data-on={value} onClick={() => onChange(!value)} aria-label={label} />
    </div>
  )
}

/** 通过一个隐藏的 file input 选文件，拿到路径后交给主进程读取 */
async function pickFile(): Promise<string | null> {
  return await new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      try {
        resolve(window.omnidesk.app.pathForFile(f))
      } catch {
        resolve(null)
      }
    }
    input.click()
  })
}

/* ------------------------------------------------------------------ */

/**
 * 本机私钥选择器
 *
 * 把扫描结果按「能不能直接用」排好序：未加密的在前，加密的标出来提醒要填口令，
 * 识别不了的放最后。用户点一下就行，不用自己去找路径。
 */
function LocalKeyPicker({
  keys,
  onPick,
  onClose
}: {
  keys: LocalSshKey[]
  onPick: (k: LocalSshKey) => void
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">选择本机私钥</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body" style={{ padding: '10px 14px' }}>
          {keys.length === 0 ? (
            <div className="empty" style={{ height: 180 }}>
              <div className="empty-title">没有找到私钥</div>
              <div className="empty-desc">
                已查找 ~/.ssh 及常见位置。如果你把密钥放在别处，请用「浏览文件…」手动选择。
              </div>
            </div>
          ) : (
            <>
              <div className="field-hint" style={{ marginBottom: 10 }}>
                共找到 {keys.length} 个。未加密的排在前面，加密的会标出来（需要填口令）。
              </div>
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {keys.map((k) => (
                  <button
                    key={k.path}
                    className="vault-choice"
                    style={{ marginBottom: 6, padding: '10px 12px' }}
                    onClick={() => onPick(k)}
                  >
                    <div className="vault-choice-head">
                      <span className="vault-choice-title">{k.name}</span>
                      <span className="badge">{k.type}</span>
                      {k.encrypted && <span className="badge badge-warning">需口令</span>}
                      {!k.readable && <span className="badge badge-danger">无法识别</span>}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        color: 'var(--text-tertiary)',
                        wordBreak: 'break-all',
                        lineHeight: 1.4
                      }}
                    >
                      {k.path}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
