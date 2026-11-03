import { useEffect, useState } from 'react'
import type { Connection } from '@shared/types'
import type { OfficialBatchResult, OfficialShare } from '@shared/account'
import { formatConnectionAddress, matchesConnection } from '@shared/connection-identity'
import Icon from '../../components/Icon'

export default function BatchSharing({ connections, shares, busy, onBusy, onChanged }: { connections: Connection[]; shares: OfficialShare[]; busy: boolean; onBusy: (value: boolean) => void; onChanged: () => void }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [local, setLocal] = useState<string[]>([])
  const [remote, setRemote] = useState<string[]>([])
  const [result, setResult] = useState<OfficialBatchResult | null>(null)
  const [error, setError] = useState('')
  const filtered = connections.filter(connection => matchesConnection(connection, search))
  const visible = filtered.slice(page * 50, page * 50 + 50)
  const owned = shares.filter(share => share.owned)
  const remoteKey = owned.map(share => share.id).join(',')
  useEffect(() => { setRemote([]) }, [remoteKey])
  const toggle = (selected: string[], id: string) => selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id].slice(0, 50)
  const run = async (action: 'publish' | 'revoke') => {
    if (busy) return
    onBusy(true); setResult(null); setError('')
    try {
      const response = action === 'publish' ? await window.omnidesk.account.publishMany(local) : await window.omnidesk.account.unpublishMany(remote)
      if (!response.ok) throw new Error(response.message)
      setResult(response.data)
      if (!response.data.cancelled) {
        const failed = response.data.failed.map(item => item.id)
        if (action === 'publish') setLocal(failed); else setRemote(failed)
        onChanged()
      }
    } catch (error) { setError(error instanceof Error ? error.message : '批量操作失败') }
    finally { onBusy(false) }
  }
  return <details className="account-batch"><summary><Icon name="layers" size={17} />批量共享 / 撤销<span>每批最多 50 台 · 失败单独列出</span></summary>
    <div className="account-batch-columns"><section aria-label="批量共享本机连接"><h3>从本机批量发布</h3><div className="search-input"><Icon name="search" size={15} /><input aria-label="搜索待共享本机连接" placeholder="名称、地址、备注、分组…" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} disabled={busy} /></div><div className="account-batch-tools"><button className="text-link" disabled={busy} onClick={() => setLocal(visible.map(item => item.id))}>选择本页</button><button className="text-link" disabled={busy} onClick={() => setLocal([])}>清空选择</button><span>已选 {local.length} 台</span></div>
      <div className="account-batch-list">{visible.map(connection => <label key={connection.id}><input type="checkbox" aria-label={'共享 ' + connection.name} checked={local.includes(connection.id)} disabled={busy || (!local.includes(connection.id) && local.length >= 50)} onChange={() => setLocal(toggle(local, connection.id))} /><div><strong>{connection.name}<small>{connection.kind.toUpperCase()}</small></strong><span>{formatConnectionAddress(connection.host, connection.port)}</span>{connection.note && <p>{connection.note}</p>}</div></label>)}{!visible.length && <p className="field-hint">没有匹配的本机连接。</p>}</div>
      <div className="account-batch-tools"><button className="btn btn-ghost btn-sm" disabled={!page || busy} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(filtered.length / 50))}</span><button className="btn btn-ghost btn-sm" disabled={busy || (page + 1) * 50 >= filtered.length} onClick={() => setPage(value => value + 1)}>下一页</button></div><button className="btn btn-primary" disabled={busy || !local.length} onClick={() => void run('publish')}>批量发布 / 更新共享（{local.length}）</button></section>
    <section aria-label="批量撤销我的共享"><h3>撤销本页我的共享</h3><p className="field-hint">仅显示下方共享目录当前页中由你发布的记录；撤销不删除本机服务器或公共凭据。</p><div className="account-batch-tools"><button className="text-link" disabled={busy} onClick={() => setRemote(owned.map(item => item.id))}>选择本页我的共享</button><button className="text-link" disabled={busy} onClick={() => setRemote([])}>清空选择</button><span>已选 {remote.length} 台</span></div><div className="account-batch-list">{owned.map(share => <label key={share.id}><input type="checkbox" aria-label={'撤销 ' + share.name} checked={remote.includes(share.id)} disabled={busy} onChange={() => setRemote(toggle(remote, share.id))} /><div><strong>{share.name}<small>{share.kind.toUpperCase()}</small></strong><span>{formatConnectionAddress(share.host, share.port)}</span></div></label>)}{!owned.length && <p className="field-hint">本页没有你发布的共享。</p>}</div><button className="btn" disabled={busy || !remote.length} onClick={() => void run('revoke')}>批量撤销共享（{remote.length}）</button></section></div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}{result && <div className={'alert ' + (result.failed.length ? 'alert-warning' : 'alert-success')} role="status">{result.cancelled ? '已取消，未发布或撤销任何共享。' : `操作完成：成功 ${result.succeeded} 台，失败 ${result.failed.length} 台。`}{result.failed.length > 0 && <ul>{result.failed.map(item => <li key={item.id}>{item.name}：{item.message}</li>)}</ul>}</div>}
  </details>
}
