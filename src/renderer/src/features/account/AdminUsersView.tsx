import { useEffect, useState } from 'react'
import type { OfficialUsers } from '@shared/account'
import Icon from '../../components/Icon'

const formatTime = (value: number | null) => value ? new Date(value).toLocaleString() : '—'

export default function AdminUsersView() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<OfficialUsers | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    const timer = setTimeout(() => {
      void window.omnidesk.account.users(search, page).then(result => {
        if (!active) return
        if (result.ok) { setData(result.data); setError('') }
        else { setData(null); setError(result.message) }
      }).catch(() => { if (active) { setData(null); setError('用户信息加载失败，请稍后重试') } }).finally(() => { if (active) setLoading(false) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [search, page, refresh])

  return <section className="account-admin card" aria-label="管理员用户管理">
    <div className="account-section-title"><div><h2><Icon name="shield" size={20} />管理员工作台</h2><p>首个注册账号为管理员。可查看所有用户的基本信息与使用状态，不展示密码、私钥或登录密钥。</p></div><span className="badge">仅管理员</span></div>
    <div className="account-admin-summary">
      {[['全部用户', data?.summary.users], ['管理员', data?.summary.administrators], ['已同步用户', data?.summary.synchronizedUsers], ['共享服务器', data?.summary.sharedServers]].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{value ?? '—'}</strong></div>)}
    </div>
    <div className="account-share-toolbar"><div className="search-input"><Icon name="search" size={16} /><input aria-label="搜索官方账号用户" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} placeholder="按用户名搜索…" /></div><button className="btn btn-ghost" disabled={loading} onClick={() => setRefresh(current => current + 1)}><Icon name="refresh" size={15} />刷新用户</button></div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    <div className="account-admin-table" aria-busy={loading}><table className="server-table"><thead><tr><th>账号</th><th>注册 / 最近登录</th><th>云端配置</th><th>共享</th><th>登录设备</th></tr></thead><tbody>{data?.items.map(user => <tr key={user.id}><td><strong>{user.username}</strong><small>{user.role === 'admin' ? '管理员' : '普通用户'}</small><span className="mono" title={user.id}>{user.id.slice(0, 8)}</span></td><td>{formatTime(user.createdAt)}<small>最近 {formatTime(user.lastLoginAt)}</small></td><td>{user.configurationRevision ? `版本 #${user.configurationRevision} · ${Math.max(1, Math.ceil((user.configurationBytes ?? 0) / 1024))} KB` : '尚未上传'}<small>{formatTime(user.configurationUpdatedAt)}</small></td><td>{user.sharedServers} 台</td><td>{user.loginSessions}</td></tr>)}</tbody></table>{!data?.items.length && !error && <div className="account-share-empty">{loading ? '正在加载用户…' : '没有匹配的用户'}</div>}</div>
    <div className="server-pagination"><span>共 {data?.total ?? 0} 个匹配账号；每页 50 个</span><button className="btn btn-sm" disabled={!page || loading} onClick={() => setPage(current => current - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil((data?.total ?? 0) / 50))}</span><button className="btn btn-sm" disabled={loading || (page + 1) * 50 >= (data?.total ?? 0)} onClick={() => setPage(current => current + 1)}>下一页</button></div>
  </section>
}
