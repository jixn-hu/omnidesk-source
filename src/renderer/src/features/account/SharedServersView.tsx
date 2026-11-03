import { TagPill } from '../../components/TagInput'
import { useEffect, useState } from 'react'
import type { OfficialAccountStatus, OfficialShare } from '@shared/account'
import { connectionKey, formatConnectionAddress } from '@shared/connection-identity'
import { useApp } from '../../store/app'
import Icon from '../../components/Icon'
import BatchSharing from './BatchSharing'

export default function SharedServersView() {
  const connections = useApp(state => state.connections)
  const [status, setStatus] = useState<OfficialAccountStatus | null>(null)
  const [shared, setShared] = useState<{ items: OfficialShare[]; total: number }>({ items: [], total: 0 })
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [selection, setSelection] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [listing, setListing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')
  const userId = status?.user?.id
  const localEndpoints = new Set(connections.map(connectionKey))
  useEffect(() => {
    let active = true
    void window.omnidesk.account.status().then(result => {
      if (!active) return
      if (result.ok) { setStatus(result.data); useApp.setState({ accountUser: result.data.user }) }
      else setError(result.message)
    }).catch(() => { if (active) setError('无法读取服务登录状态') })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!userId) return
    let active = true
    setListing(true)
    const timer = setTimeout(() => {
      void window.omnidesk.account.shares(search, page).then(result => {
        if (!active) return
        if (result.ok) {
          if (page && !result.data.items.length) { setPage(current => current - 1); return }
          setShared(result.data); setListError('')
        } else setListError(result.message)
      }).catch(() => { if (active) setListError('共享服务器暂时不可用，请重试') }).finally(() => { if (active) setListing(false) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [userId, search, page, refresh])
  const operate = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const importShare = (share: OfficialShare) => operate(async () => {
    const result = await window.omnidesk.account.importShare(share.id)
    if (!result.ok) throw new Error(result.message)
    if (!result.data) return
    const local = await window.omnidesk.connections.list()
    if (local.ok) useApp.getState().setConnections(local.data)
    setNotice(result.data.skipped ? '本机已有相同服务器，已跳过，保留本机配置和凭据。' : '已拉取到本机。可在个人服务器管理中独立连接和编辑。')
  })
  const login = () => useApp.getState().openTab({ id: 'tab-account', kind: 'account', title: '账号与同步', status: 'idle' })
  return <div className="account-workspace shared-servers-workspace">
    <header className="account-heading"><div><div className="eyebrow">SHARED SERVERS</div><h1>共享服务器</h1><p>团队服务器与个人共享集中在这里。拉取到本机后，使用本机 SSH / RDP 直接连接。</p></div><div className="shared-heading-actions"><button className="btn btn-ghost" onClick={login}><Icon name="user" size={16} />{status?.user?.username || '登录服务账号'}</button>{status?.user?.role === 'admin' && <button className="btn" disabled={busy} onClick={() => void operate(async () => { const result = await window.omnidesk.account.openAdmin(); if (!result.ok) throw new Error(result.message) })}><Icon name="link" size={16} />Web 管理共享服务器</button>}</div></header>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}{notice && <div className="alert alert-success" role="status">{notice}</div>}
    {!status ? <div className="empty-state">正在读取服务状态…</div> : !userId ? <section className="card"><h2>登录后查看共享服务器</h2><p className="field-hint">在账号页面配置你的 omnidesk-server 地址并登录。个人连接始终保存在本机，可继续独立使用。</p><button className="btn btn-primary" onClick={login}>配置服务并登录</button></section> : <>
      <section className="account-sharing card"><div className="account-section-title"><div><h2><Icon name="server" size={20} />服务器目录</h2><p>管理员在 Web 端维护团队配置，也会列出成员主动共享的服务器。</p></div><span className="badge">{shared.total} 台</span></div>
        <div className="account-share-toolbar"><div className="search-input"><Icon name="search" size={16} /><input aria-label="搜索共享服务器" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} placeholder="搜索名称、地址、账号、分组、备注…" /></div><button className="btn btn-ghost" disabled={listing || busy} onClick={() => setRefresh(current => current + 1)}><Icon name="refresh" size={15} />刷新</button></div>
        {listError && <div className="alert alert-warning" role="alert">{listError}</div>}
        <div className="account-shared-list" aria-busy={listing}>{shared.items.map(share => <article className="account-shared-item" key={share.id}><span className={`conn-item-badge ${share.kind}`}>{share.kind.toUpperCase()}</span><div className="account-shared-main"><strong>{share.name}<span className="badge">{share.source === 'managed' ? '管理员维护' : share.owned ? '我的共享' : '用户共享'}</span>{localEndpoints.has(connectionKey(share)) && <span className="badge">本机已有</span>}</strong><div className="mono">{share.username}@{formatConnectionAddress(share.host, share.port)}</div>{!!share.tags?.length && <div className="server-tags">{share.tags.map(tag => <TagPill key={tag} tag={tag} />)}</div>}<p>{share.note || '暂无备注'}</p><small>{share.group ? share.group + ' · ' : ''}维护者：{share.owner}{!share.downloadable && ' · 旧版共享，需重新确认凭据可下载'}</small></div><div className="account-shared-actions"><button className="btn btn-sm" disabled={busy || !share.downloadable || localEndpoints.has(connectionKey(share))} onClick={() => void importShare(share)}><Icon name="import" size={14} />{localEndpoints.has(connectionKey(share)) ? '本机已有' : '拉取到本机'}</button>{share.owned && share.source !== 'managed' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void operate(async () => { const result = await window.omnidesk.account.unpublish(share.id); if (!result.ok) throw new Error(result.message); if (result.data) { setNotice('已撤销个人共享，已下载的本地连接不受影响。'); setRefresh(current => current + 1) } })}>撤销我的共享</button>}</div></article>)}{!shared.items.length && !listError && <div className="account-share-empty">{listing ? '正在读取共享目录…' : search ? '没有匹配的服务器' : '暂无共享服务器。管理员可在 Web 管理台直接新建或导入。'}</div>}</div>
        <div className="server-pagination"><span>拉取包含服务器凭据；本机已有相同入口时跳过。</span><button className="btn btn-sm" disabled={!page || listing} onClick={() => setPage(current => current - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(shared.total / 50))}</span><button className="btn btn-sm" disabled={(page + 1) * 50 >= shared.total || listing} onClick={() => setPage(current => current + 1)}>下一页</button></div>
      </section>
      <details className="account-sharing card personal-sharing"><summary>共享我的本机服务器<span>按需发布个人配置</span></summary><p className="field-hint account-copy-warning">其他已登录用户将获得所发布的密码或私钥。已下载的副本无法远程收回。</p><div className="account-publish"><label className="field">选择本机连接<select aria-label="选择要共享的本机连接" value={selection} onChange={event => setSelection(event.target.value)} disabled={busy}><option value="">请选择本机服务器…</option>{connections.map(connection => <option value={connection.id} key={connection.id}>{connection.name} · {connection.kind.toUpperCase()}</option>)}</select></label><button className="btn" disabled={busy || !selection} onClick={() => void operate(async () => { const result = await window.omnidesk.account.publish(selection); if (!result.ok) throw new Error(result.message); if (result.data) { setNotice('个人共享已发布。'); setRefresh(current => current + 1); setPage(0) } })}>发布 / 更新我的共享</button></div><BatchSharing connections={connections} shares={shared.items.filter(share => share.source !== 'managed')} busy={busy} onBusy={setBusy} onChanged={() => setRefresh(current => current + 1)} /></details>
    </>}
  </div>
}
