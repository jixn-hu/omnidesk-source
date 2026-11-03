import { useEffect, useState } from 'react'
import type { SharedCredential } from '@shared/types'
import { useApp } from '../../store/app'
import Icon from '../../components/Icon'

export default function CredentialsView() {
  const connections = useApp((state) => state.connections)
  const [items, setItems] = useState<SharedCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<SharedCredential | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')

  const load = async () => {
    try {
      const result = await window.omnidesk.shared.list()
      if (result.ok) setItems(result.data)
      else setError(result.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取公共凭据失败')
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const remove = async (item: SharedCredential) => {
    if (!confirm(`删除公共凭据「${item.name}」？此操作不可撤销。`)) return
    setBusy(true)
    setError('')
    try {
      const result = await window.omnidesk.shared.remove(item.id)
      if (!result.ok) { setError(result.message); return }
      setItems((current) => current.filter((entry) => entry.id !== item.id))
      setMessage('公共凭据已删除')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '删除失败')
    } finally { setBusy(false) }
  }

  const matched = items.filter((item) => `${item.name} ${item.username ?? ''} ${item.note ?? ''}`.toLowerCase().includes(query.toLowerCase()))

  return <div className="pane credentials-page">
    <div className="page-heading">
      <div><div className="eyebrow">IDENTITY & ACCESS</div><h1>公共凭据</h1>
        <p>一份账号与凭证，安全复用到多台服务器。</p><button className="btn btn-sm" onClick={() => useApp.getState().openTab({ id: 'tab-servers', kind: 'servers', title: '服务器管理', status: 'idle' })}>选择服务器，批量测试公共凭据</button></div>
      <button className="btn btn-primary" onClick={() => setEditing(null)}><Icon name="plus" size={16} />新建公共凭据</button>
    </div>
    <div className="credential-explainer">
      <div className="feature-icon"><Icon name="shield" size={24} /></div>
      <div><strong>账号、密码、私钥，集中维护</strong><p>在连接编辑器中选择「凭据来源」即可关联。更新一次，下次建立连接时统一使用新凭据，不会中断当前会话。</p></div>
      <span className="badge">本机加密存储</span>
    </div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {message && <div className="alert alert-success" role="status">{message}</div>}
    <div className="section-heading"><h2>凭据库 <span>{items.length}</span></h2>
      <div className="search-field"><Icon name="search" size={15} /><input aria-label="搜索公共凭据" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或账号" /></div>
    </div>
    {loading ? <div className="empty">正在读取凭据…</div> : matched.length === 0 ? <div className="credentials-empty">
      <div className="feature-icon"><Icon name="key" size={28} /></div><h2>{query ? '没有匹配的凭据' : '把重复填写，变成一次配置'}</h2>
      <p>{query ? '试试其他名称或账号。' : '例如：生产环境的统一运维账号、Windows 域账号，或多台 Linux 共用的 SSH 私钥。'}</p>
      {!query && <button className="btn btn-primary" onClick={() => setEditing(null)}>创建第一条公共凭据</button>}
    </div> : <div className="credential-grid">{matched.map((item) => {
      const usedBy = connections.filter((connection) => connection.sharedCredentialId === item.id)
      return <article className="credential-card" key={item.id}>
        <div className="credential-card-heading"><span className="credential-symbol"><Icon name="key" size={20} /></span>
          <span className="badge">{item.kind === 'password' ? '账号 / 密码' : 'SSH 私钥'}</span></div>
        <h3>{item.name}</h3><div className="credential-account mono">{item.domain ? `${item.domain}\\` : ''}{item.username || '使用各连接自己的账号'}</div>
        <p className="credential-note">{item.note || '密钥内容已加密，不在界面中回显。'}</p>
        <div className="credential-usage" title={usedBy.map((connection) => connection.name).join('、')}><Icon name="link" size={14} />{usedBy.length} 条连接引用</div>
        {usedBy.length > 0 && <div className="credential-hosts">{usedBy.map((connection) => connection.name).join(' · ')}</div>}
        <div className="credential-actions"><button className="btn btn-sm" onClick={() => setEditing(item)}>编辑凭据</button>
          <button className="btn btn-ghost btn-sm" disabled={busy || usedBy.length > 0} title={usedBy.length ? '请先解除连接引用' : '删除凭据'} onClick={() => void remove(item)}>删除</button></div>
      </article>
    })}</div>}
    {editing !== undefined && <CredentialEditor key={editing?.id ?? 'new'} item={editing} onClose={() => setEditing(undefined)} onSaved={(saved) => {
      setItems((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved])
      setEditing(undefined)
      setMessage('公共凭据已保存。关联连接将在下次连接时使用最新账号与凭证。')
    }} />}
  </div>
}

function CredentialEditor({ item, onClose, onSaved }: { item: SharedCredential | null; onClose: () => void; onSaved: (item: SharedCredential) => void }) {
  const [name, setName] = useState(item?.name ?? '')
  const [kind, setKind] = useState<SharedCredential['kind']>(item?.kind ?? 'password')
  const [username, setUsername] = useState(item?.username ?? '')
  const [domain, setDomain] = useState(item?.domain ?? '')
  const [secret, setSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [note, setNote] = useState(item?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose, saving])

  const save = async () => {
    if (saving) return
    setError('')
    if (!name.trim()) return setError('请填写凭据名称')
    if (!item && !secret.length) return setError(kind === 'password' ? '请填写密码' : '请填写 SSH 私钥')
    setSaving(true)
    try {
      const result = await window.omnidesk.shared.save({ id: item?.id, name: name.trim(), kind, username: username.trim(), domain: domain.trim(),
        secret: secret || undefined, passphrase: kind === 'privateKey' && passphrase ? passphrase : undefined, note: note.trim() || undefined })
      if (!result.ok) { setError(result.message); return }
      onSaved(result.data)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败，请重试') }
    finally { setSaving(false) }
  }

  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <form className="modal modal-lg" role="dialog" aria-modal="true" aria-label={item ? '编辑公共凭据' : '新建公共凭据'} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="modal-header"><div><h2 className="modal-title">{item ? '编辑公共凭据' : '新建公共凭据'}</h2><div className="field-hint">只维护一份，按需关联多个连接</div></div>
        <button type="button" aria-label="关闭凭据编辑器" disabled={saving} className="btn btn-ghost btn-icon" onClick={onClose}><Icon name="close" /></button></div>
      <div className="modal-body">
        <label className="field"><span className="field-label">凭据名称</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：生产环境统一运维账号" /></label>
        <label className="field"><span className="field-label">凭据类型</span><select value={kind} disabled={!!item} onChange={(event) => { setKind(event.target.value as SharedCredential['kind']); setSecret('') }}><option value="password">账号与密码 · SSH / RDP</option><option value="privateKey">SSH 私钥</option></select></label>
        <div className="field-row"><label className="field"><span className="field-label">共享账号（可选）</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="root / Administrator" autoComplete="off" /><span className="field-hint">留空则沿用每条连接的用户名；填写后统一使用此账号。</span></label>
          {kind === 'password' && <label className="field"><span className="field-label">Windows 域（可选）</span><input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="本地账号可留空" /></label>}</div>
        <label className="field"><span className="field-label">{kind === 'password' ? '密码' : '私钥内容'}</span>
          {kind === 'password' ? <input aria-label="密码" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" placeholder={item ? '已保存；留空保持原密码' : '输入共享密码'} />
            : <textarea aria-label="私钥内容" className="mono" rows={6} value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={item ? '已加密保存；留空保持原私钥' : '-----BEGIN OPENSSH PRIVATE KEY-----'} spellCheck={false} />}
          <span className="field-hint">凭证内容仅写入本机加密保险箱，不会在列表中显示。</span></label>
        {kind === 'privateKey' && <label className="field"><span className="field-label">私钥口令（可选）</span><input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder={item ? '留空保持原口令' : '未加密私钥无需填写'} autoComplete="new-password" /></label>}
        <label className="field"><span className="field-label">备注（可选）</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="用途、适用环境或维护说明" /></label>
        {error && <div className="alert alert-danger" role="alert">{error}</div>}
      </div>
      <div className="modal-footer"><button type="button" className="btn" disabled={saving} onClick={onClose}>取消</button><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存公共凭据'}</button></div>
    </form>
  </div>
}
