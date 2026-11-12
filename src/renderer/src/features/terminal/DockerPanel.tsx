import { useEffect, useRef, useState } from 'react'
import type { DockerContainer, DockerImage, DockerRemoveRequest, DockerSnapshot } from '@shared/docker'
import Icon from '../../components/Icon'
import './docker.css'

type Target = { kind: DockerRemoveRequest['kind']; id: string; name: string }
const stateLabels: Record<string, string> = { running: '运行中', exited: '已停止', created: '已创建', restarting: '重启中', paused: '已暂停', removing: '删除中', dead: '异常' }
const canRemove = (container: DockerContainer) => ['exited', 'created', 'dead'].includes(container.state)
const shortId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12)

export default function DockerPanel({ sessionId, active, serverName }: { sessionId?: string; active: boolean; serverName: string }) {
  const [data, setData] = useState<DockerSnapshot>()
  const [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [revision, setRevision] = useState(0), [section, setSection] = useState<'container' | 'image'>('container')
  const [query, setQuery] = useState(''), [success, setSuccess] = useState('')
  const [target, setTarget] = useState<Target>(), [removeError, setRemoveError] = useState(''), [busy, setBusy] = useState(false)
  const removing = useRef(false), mounted = useRef(true)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!active || !sessionId) return
    let cancelled = false
    setLoading(true); setError('')
    window.omnidesk.docker.snapshot(sessionId).then(result => {
      if (cancelled) return
      if (result.ok) setData(result.data)
      else setError(result.message)
    }).catch(() => { if (!cancelled) setError('读取 Docker 失败，请检查 SSH 连接后重试。') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId, active, revision])
  useEffect(() => {
    if (!active && !removing.current) { setTarget(undefined); setRemoveError('') }
  }, [active])
  useEffect(() => {
    if (!target) return
    const previous = document.activeElement as HTMLElement | null
    cancelButton.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [target])
  const requestRemove = (next: Target) => { setRemoveError(''); setSuccess(''); setTarget(next) }
  const remove = async () => {
    if (removing.current || !target || !sessionId || !active || !data?.endpoint || !data.daemonId || loading || error) return
    removing.current = true; setBusy(true); setRemoveError('')
    try {
      const result = await window.omnidesk.docker.remove(sessionId, { kind: target.kind, id: target.id, endpoint: data.endpoint, daemonId: data.daemonId })
      if (!mounted.current) return
      if (!result.ok) { setRemoveError(result.message); return }
      setSuccess('已删除' + (target.kind === 'container' ? '容器' : '镜像') + '「' + target.name + '」')
      setTarget(undefined); setRevision(value => value + 1)
    } catch { if (mounted.current) setRemoveError('删除结果未确认，请关闭弹窗并刷新列表后检查。') }
    finally { removing.current = false; if (mounted.current) setBusy(false) }
  }
  const needle = query.trim().toLowerCase()
  const containers = data?.containers.filter(item => [item.name, item.id, item.image, item.state, stateLabels[item.state]].some(value => value?.toLowerCase().includes(needle))) ?? []
  const images = data?.images.filter(item => [item.id, ...item.tags].some(value => value.toLowerCase().includes(needle))) ?? []
  const stale = loading || !!error || !active || busy
  const title = !data ? '检查 Docker 环境' : data.available ? 'Docker' : data.reason === 'not-installed' ? '未检测到 Docker' : data.reason === 'permission' ? 'Docker 权限不足' : 'Docker 暂不可用'

  return <div className="docker-panel">
    <div className="docker-panel-toolbar"><span>{data?.available ? 'Docker ' + data.version : '当前 SSH 服务器'}</span><button className="btn btn-ghost btn-icon" aria-label="刷新 Docker" title="刷新 Docker 列表" disabled={!sessionId || loading || busy || !!target} onClick={() => { setSuccess(''); setRevision(value => value + 1) }}><Icon name="refresh" size={14} /></button></div>
    {!sessionId ? <div className="terminal-sidebar-empty"><Icon name="layers" size={28} /><strong>连接 SSH 后查看 Docker</strong><span>使用服务器上已有的 Docker 服务。</span></div> : <>
      {success && <div className="docker-feedback" role="status"><Icon name="check" size={14} /><span>{success}</span></div>}
      {error && <div className="terminal-metrics-error" role="alert"><strong>读取失败</strong><span>{error}</span>{data?.available && <small>以下为上次数据，刷新成功后可操作。</small>}</div>}
      {!data && loading && <div className="terminal-sidebar-empty" role="status"><div className="spinner" /><span>正在检测 Docker 并读取资源…</span></div>}
      {data && !data.available && <div className="terminal-sidebar-empty"><Icon name="layers" size={28} /><strong>{title}</strong><span>{data.message}</span><button className="btn" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? '检测中…' : '重新检测'}</button></div>}
      {data?.available && <>
        <div className="docker-summary"><span><i className="dot dot-connected" />{data.containers.filter(item => item.state === 'running').length} 个运行中</span><time title={data.endpoint}>{loading ? '刷新中…' : new Date(data.collectedAt).toLocaleTimeString()}</time></div>
        <div className="docker-sections" role="group" aria-label="Docker 资源类型"><button aria-pressed={section === 'container'} onClick={() => { setSection('container'); setQuery('') }}>容器 <small>{data.containers.length}</small></button><button aria-pressed={section === 'image'} onClick={() => { setSection('image'); setQuery('') }}>镜像 <small>{data.images.length}</small></button></div>
        <label className="docker-search"><Icon name="search" size={14} /><input aria-label="搜索 Docker 资源" placeholder={section === 'container' ? '搜索容器、镜像或 ID' : '搜索镜像标签或 ID'} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="docker-resource-list" aria-busy={loading}>
          {section === 'container' ? containers.map(item => <article className="docker-resource" key={item.id}>
            <div className="docker-resource-title"><strong title={item.name}>{item.name || shortId(item.id)}</strong><span className="docker-state" data-running={item.state === 'running'}>{stateLabels[item.state] || item.state}</span></div>
            <p className="docker-resource-image" title={item.image}>{item.image}</p>
            <p className="docker-resource-ports">{item.ports || '未发布端口'}</p>
            <div className="docker-resource-actions"><details><summary>查看详情</summary><dl><dt>ID</dt><dd>{item.id}</dd><dt>状态</dt><dd>{item.status}</dd><dt>创建时间</dt><dd>{item.created}</dd></dl></details><button className="btn btn-ghost btn-icon docker-remove" aria-label={'删除容器 ' + item.name} disabled={stale || !canRemove(item)} title={canRemove(item) ? '删除此容器' : '请先在终端停止容器，再刷新后删除'} onClick={() => requestRemove({ kind: 'container', id: item.id, name: item.name || shortId(item.id) })}><Icon name="trash" size={14} /></button></div>
          </article>) : images.map(item => <ImageCard key={item.id} item={item} disabled={stale} onRemove={() => requestRemove({ kind: 'image', id: item.id, name: item.tags.join('、') || shortId(item.id) })} />)}
          {(section === 'container' ? containers.length : images.length) === 0 && <div className="docker-list-empty">{needle ? '没有匹配的资源' : section === 'container' ? '暂无容器' : '暂无镜像'}</div>}
        </div>
        <p className="docker-panel-hint">运行中的容器请先在终端停止，再刷新后删除。镜像被引用时会提示原因。</p>
      </>}
    </>}
    {target && active && <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget && !busy) setTarget(undefined) }} onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); setTarget(undefined) }
      if (event.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        if (!buttons?.length) { event.preventDefault(); return }
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }}><section ref={dialog} className="modal docker-confirm" role="dialog" aria-modal="true" aria-labelledby={'docker-delete-' + sessionId}>
      <header className="modal-header"><h2 id={'docker-delete-' + sessionId}>删除{target.kind === 'container' ? '容器' : '镜像'}</h2></header>
      <div className="modal-body"><p>确定从「{serverName}」删除以下{target.kind === 'container' ? '容器' : '镜像'}？</p><strong className="docker-delete-name">{target.name}</strong><code className="docker-delete-id">{target.id}</code><p className="field-hint">{target.kind === 'container' ? '容器的可写层会丢失，此操作无法撤销。数据卷和宿主机目录会保留。' : '此操作无法撤销。被容器或多个标签引用的镜像可能无法删除，请根据 Docker 提示处理。'}</p>{removeError && <p className="alert alert-danger" role="alert">{removeError}</p>}</div>
      <footer className="modal-footer"><button ref={cancelButton} className="btn" disabled={busy} onClick={() => setTarget(undefined)}>取消</button><button className="btn btn-danger" disabled={busy || loading || !!error} onClick={() => void remove()}>{busy ? '删除中…' : '确认删除'}</button></footer>
    </section></div>}
  </div>
}

function ImageCard({ item, disabled, onRemove }: { item: DockerImage; disabled: boolean; onRemove: () => void }) {
  const name = item.tags[0] || '无标签镜像'
  return <article className="docker-resource">
    <div className="docker-resource-title"><strong title={item.tags.join('\n') || item.id}>{name}</strong><span className="docker-image-size">{item.size}</span></div>
    <p className="docker-image-id">{shortId(item.id)}{item.tags.length > 1 ? ' · ' + item.tags.length + ' 个标签' : ''}</p>
    <div className="docker-resource-actions"><details><summary>查看详情</summary><dl><dt>ID</dt><dd>{item.id}</dd><dt>标签</dt><dd>{item.tags.join('\n') || '无标签'}</dd><dt>创建时间</dt><dd>{item.created}</dd></dl></details><button className="btn btn-ghost btn-icon docker-remove" aria-label={'删除镜像 ' + name} title="删除此镜像" disabled={disabled} onClick={onRemove}><Icon name="trash" size={14} /></button></div>
  </article>
}
