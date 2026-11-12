import { useCallback, useEffect, useRef, useState, type MouseEvent, type DragEvent } from 'react'
import { useApp, type Tab } from '../../store/app'
import type { RemoteFileEntry, TransferTask } from '@shared/types'
import FileContextMenu from './FileContextMenu'
import FileEditor from './FileEditor'
import { REMOTE_PATH_MIME } from './remote-path-drag'

/**
 * SFTP 文件管理
 *
 * 浏览、编辑、上传、下载、重命名、删除与新建。
 * 刻意不做多选批量操作 —— 那需要一套选中态管理和确认流程，
 * 属于后续迭代，先保证单文件操作可靠。
 */
export default function FilesView({ tab, compact = false, active = true }: { tab: Tab; compact?: boolean; active?: boolean }) {
  const [path, setPath] = useState('')
  const [dropDirectory, setDropDirectory] = useState<string | null>(null)
  const [dragBusy, setDragBusy] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [entries, setEntries] = useState<RemoteFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [transfers, setTransfers] = useState<TransferTask[]>([])
  const [selected, setSelected] = useState<RemoteFileEntry | null>(null)
  const [nameAction, setNameAction] = useState<{ kind: 'file' | 'mkdir' | 'rename'; directory: string; entry?: RemoteFileEntry } | null>(null)
  const [entryName, setEntryName] = useState('')
  const [nameError, setNameError] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [editorEntry, setEditorEntry] = useState<RemoteFileEntry | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: RemoteFileEntry } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const lastPath = useRef('')
  const requestRevision = useRef(0)

  const connections = useApp((s) => s.connections)
  const openTab = useApp((s) => s.openTab)
  const connection = connections.find((c) => c.id === tab.connectionId)

  // 若标签没带 sessionId，就去找该连接当前的活跃会话
  const sessions = useApp((s) => s.sessions)
  const sessionId =
    tab.sessionId
      ? sessions.find(session => session.id === tab.sessionId && session.connectionId === tab.connectionId && session.kind === 'ssh' && session.status === 'connected')?.id
      : sessions.find((s) => s.connectionId === tab.connectionId && s.kind === 'ssh' && s.status === 'connected')?.id

  const load = useCallback(
    async (target: string) => {
      if (!sessionId) return
      const revision = ++requestRevision.current
      setLoading(true)
      setError('')
      try {
        const res = await window.omnidesk.sftp.list(sessionId, target || '.')
        if (revision !== requestRevision.current) return
        if (!res.ok) { setError(res.message); return }
        lastPath.current = res.data.path
        setPath(res.data.path)
        setPathInput(res.data.path)
        setEntries(res.data.entries)
        setSelected(null)
      } catch (error) {
        if (revision === requestRevision.current) setError(error instanceof Error ? error.message : '读取远程目录失败')
      } finally {
        if (revision === requestRevision.current) setLoading(false)
      }
    },
    [sessionId]
  )

  /* 首次进入：拿家目录 */
  useEffect(() => {
    if (!sessionId || !active) return
    let cancelled = false
    void load(lastPath.current || '.')
    void window.omnidesk.sftp.transfers(sessionId).then((r) => {
      if (!cancelled && r.ok) setTransfers(r.data)
    })
    return () => { cancelled = true }
  }, [sessionId, load, active])

  useEffect(() => () => { requestRevision.current++ }, [sessionId])

  useEffect(() => { setMenu(null) }, [active, sessionId, path])

  /* 传输进度订阅 */
  useEffect(() => {
    const off = window.omnidesk.sftp.onProgress((task) => {
      if (task.sessionId !== sessionId) return
      setTransfers((prev) => {
        const idx = prev.findIndex((t) => t.id === task.id)
        return idx >= 0 ? prev.map((t) => (t.id === task.id ? task : t)) : [...prev, task]
      })
    })
    return () => off()
  }, [sessionId])

  if (!sessionId) {
    return (
      <div className="empty">
        <div className="empty-title">没有可用的连接</div>
        <div className="empty-desc">
          文件管理需要一条已建立的 SSH 会话。请先打开该主机的终端。
        </div>
        {connection && (
          <button
            className="btn btn-primary"
            onClick={() =>
              openTab({ kind: 'ssh', title: connection.name, connectionId: connection.id, status: 'idle' })
            }
          >
            打开终端
          </button>
        )}
      </div>
    )
  }

  const enter = (entry: RemoteFileEntry) => {
    if (entry.type === 'directory') {
      void load(entry.path)
    } else {
      setSelected(entry)
      setEditorEntry(entry)
    }
  }

  const goUp = () => {
    const parent = path.replace(/\/[^/]+\/?$/, '') || '/'
    void load(parent)
  }

  const refresh = () => void load(path)

  const doCreate = (kind: 'file' | 'mkdir') => {
    if (savingName || !path) return
    setNameAction({ kind, directory: path })
    setEntryName('')
    setNameError('')
  }

  const doRename = (entry: RemoteFileEntry) => {
    if (savingName) return
    setNameAction({ kind: 'rename', directory: path, entry })
    setEntryName(entry.name)
    setNameError('')
  }

  const saveName = async () => {
    if (!nameAction || savingName) return
    const name = entryName.trim()
    if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) { setNameError('请输入有效名称，不包含路径分隔符'); return }
    setSavingName(true)
    setNameError('')
    try {
      const target = (nameAction.directory.endsWith('/') ? nameAction.directory : nameAction.directory + '/') + name
      if (nameAction.kind === 'rename' && target === nameAction.entry!.path) { setNameAction(null); return }
      if (nameAction.directory === path && entries.some(entry => entry.name === name)) { setNameError('同名文件或目录已存在，请使用其他名称'); return }
      const result = nameAction.kind === 'mkdir' ? await window.omnidesk.sftp.mkdir(sessionId, target) : nameAction.kind === 'file' ? await window.omnidesk.sftp.createFile(sessionId, target) : await window.omnidesk.sftp.rename(sessionId, nameAction.entry!.path, target)
      if (!result.ok) { setNameError(result.message); return }
      setNameAction(null)
      refresh()
    } catch (error) { setNameError(error instanceof Error ? error.message : '保存名称失败') }
    finally { setSavingName(false) }
  }

  const doDelete = async (entry: RemoteFileEntry) => {
    const isDir = entry.type === 'directory'
    const label = isDir ? '目录' : '文件'
    if (!confirm(`确定删除${label}「${entry.name}」？\n${isDir ? '目录必须为空才能删除。' : ''}`)) return
    const res = await window.omnidesk.sftp.remove(sessionId, entry.path, isDir)
    if (!res.ok) setError(res.message)
    else refresh()
  }

  const dragOver = (event: DragEvent, directory: string) => {
    if (dragBusy || !directory || !event.dataTransfer.types.some(type => type === 'Files' || type === REMOTE_PATH_MIME)) return
    event.preventDefault(); event.stopPropagation()
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(REMOTE_PATH_MIME) ? 'move' : 'copy'
    setDropDirectory(directory)
  }
  const dropFiles = async (event: DragEvent, directory: string) => {
    event.preventDefault(); event.stopPropagation(); setDropDirectory(null)
    if (!directory || dragBusy) return
    const remote = event.dataTransfer.getData(REMOTE_PATH_MIME), local = [...event.dataTransfer.files]
    setDragBusy(true); setError('')
    try {
      if (remote) {
        const payload = JSON.parse(remote)
        if (payload.sessionId !== sessionId || typeof payload.path !== 'string') throw new Error('只能移动当前 SSH 会话内的文件；跨服务器请先下载再上传')
        const result = await window.omnidesk.sftp.move(sessionId, payload.path, directory)
        if (!result.ok) throw new Error(result.message)
      } else if (local.length) {
        const result = await window.omnidesk.sftp.uploadFiles(sessionId, directory, local)
        if (!result.ok) throw new Error(result.message)
      }
      await load(path)
    } catch (error) { setError(error instanceof Error ? error.message : '拖拽操作失败') }
    finally { setDragBusy(false) }
  }
  const dragToLocal = (event: DragEvent, entry: RemoteFileEntry) => {
    event.preventDefault(); event.stopPropagation(); closeMenu(); setError('')
    void window.omnidesk.sftp.dragToLocal(sessionId, entry.path).then(result => { if (!result.ok) setError(result.message) })
  }

  const doDownload = async (entry: RemoteFileEntry) => {
    const res = await window.omnidesk.sftp.download(sessionId, entry.path, entry.name)
    if (!res.ok) setError(res.message)
  }

  const doUpload = async () => {
    const res = await window.omnidesk.sftp.upload(sessionId, path)
    if (!res.ok) setError(res.message)
    else if (res.data.length) refresh()
  }

  const copyPath = async (target: string) => {
    try { await navigator.clipboard.writeText(target) }
    catch { setError('无法写入剪贴板，可以从底部选中并复制路径') }
  }

  const showMenu = (event: MouseEvent, entry?: RemoteFileEntry) => {
    event.preventDefault()
    event.stopPropagation()
    if (savingName || !path) return
    setSelected(entry ?? null)
    setMenu({ x: event.clientX, y: event.clientY, entry })
  }

  const activeTransfers = transfers.filter((t) => t.status === 'running' || t.status === 'pending')

  return (
    <div className={`files-layout${compact ? ' files-layout-compact' : ''}`}>
      <div className="files-pathbar">
        <button className="btn btn-sm btn-icon" onClick={goUp} onDragOver={event => dragOver(event, path.replace(/\/[^/]+\/?$/, '') || '/')} onDrop={event => void dropFiles(event, path.replace(/\/[^/]+\/?$/, '') || '/')} title="上级目录 · 可拖入移动" aria-label="上级目录">
          ↑
        </button>
        <button className="btn btn-sm btn-icon" onClick={refresh} title="刷新" aria-label="刷新">
          ↻
        </button>
        <input
          aria-label="远程目录"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(pathInput)}
          spellCheck={false}
        />
        <button className="btn btn-sm" onClick={doUpload}>
          上传
        </button>
        <button className="btn btn-sm" disabled={!path || savingName} onClick={() => doCreate('file')}>
          新建文件
        </button>
        <button className="btn btn-sm" disabled={!path || savingName} onClick={() => doCreate('mkdir')}>
          新建目录
        </button>
      </div>

      {nameAction && <form className="file-name-editor" aria-label={nameAction.kind === 'mkdir' ? '新建目录' : nameAction.kind === 'file' ? '新建文件' : '重命名文件'} onSubmit={event => { event.preventDefault(); void saveName() }}>
        <label htmlFor={`file-name-${tab.id}`}>{nameAction.kind === 'mkdir' ? '新目录名称' : nameAction.kind === 'file' ? '新文件名称' : '新的文件名称'}</label><div><input id={`file-name-${tab.id}`} autoFocus value={entryName} disabled={savingName} onChange={event => setEntryName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && !savingName) setNameAction(null) }} /><button className="btn btn-sm" disabled={savingName} type="submit">{savingName ? '保存中…' : '保存'}</button><button className="btn btn-ghost btn-sm" type="button" disabled={savingName} onClick={() => setNameAction(null)}>取消</button></div>{nameError && <small role="alert">{nameError}</small>}
      </form>}

      {error && (
        <div className="alert alert-danger" style={{ margin: '10px 12px 0' }}>
          {error}
        </div>
      )}

      {activeTransfers.length > 0 && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          {activeTransfers.map((t) => {
            const pct = t.size > 0 ? Math.round((t.transferred / t.size) * 100) : 0
            return (
              <div key={t.id} style={{ fontSize: 11.5, marginBottom: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span className="mono">
                    {t.direction === 'upload' ? '↑' : '↓'} {t.remotePath.split('/').pop()}
                  </span>
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {pct}% · {formatBytes(t.transferred)} / {formatBytes(t.size)}
                  </span>
                </div>
                <div className="bar" style={{ marginTop: 0 }}>
                  <div className="bar-fill" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className={`files-list${dropDirectory === path ? ' is-file-drop' : ''}`} aria-label="远程文件列表" onContextMenu={event => showMenu(event)} onScroll={closeMenu} onDragOver={event => dragOver(event, path)} onDrop={event => void dropFiles(event, path)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropDirectory(null) }}>
        <div className="files-row files-row-head">
          <span />
          <span>名称</span>
          <span style={{ textAlign: 'right' }}>大小</span>
          <span style={{ textAlign: 'right' }}>权限</span>
          <span style={{ textAlign: 'right' }}>修改时间</span>
        </div>

        {loading && entries.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)' }}>
            读取中…
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)' }}>
            目录为空
          </div>
        )}

        {entries.map((entry) => (
          <div
            key={entry.path}
            className={`files-row${entry.type === 'directory' && dropDirectory === entry.path ? ' is-file-drop' : ''}`}
            onDragOver={event => { if (entry.type === 'directory') dragOver(event, entry.path) }}
            onDrop={event => { if (entry.type === 'directory') void dropFiles(event, entry.path) }}
            data-remote-file={entry.path}
            tabIndex={0}
            draggable
            title={`${entry.path}\n${entry.modeText} · ${formatTime(entry.mtime)}`}
            onDoubleClick={() => enter(entry)}
            onClick={() => setSelected(entry)}
            onContextMenu={event => showMenu(event, entry)}
            onDragStart={event => {
              setSelected(entry)
              closeMenu()
              event.dataTransfer.effectAllowed = 'copyMove'
              event.dataTransfer.setData(REMOTE_PATH_MIME, JSON.stringify({ sessionId, path: entry.path }))
              event.dataTransfer.setData('text/plain', entry.path)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); enter(entry) }
              if (event.key === 'F2') { event.preventDefault(); doRename(entry) }
              if (event.key === 'Delete') { event.preventDefault(); void doDelete(entry) }
              if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); setSelected(entry); setMenu({ x: bounds.left + 20, y: bounds.bottom, entry }) }
            }}
            style={selected?.path === entry.path ? { background: 'var(--surface-active)' } : undefined}
          >
            <span style={{ fontSize: 13, textAlign: 'center' }}>
              {entry.type === 'directory' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄'}
            </span>
            <span className="files-name"><span className="files-basename">{entry.name}</span>{entry.type !== 'symlink' && entry.type !== 'other' && <button className="file-local-drag" draggable aria-label={'拖到本机下载 ' + entry.name} title="按住拖到本机文件夹，松开后下载" onClick={event => event.stopPropagation()} onDragStart={event => dragToLocal(event, entry)}>↗</button>}</span>
            <span className="files-muted">
              {entry.type === 'directory' ? '—' : formatBytes(entry.size)}
            </span>
            <span className="files-muted">{entry.modeText}</span>
            <span className="files-muted">{formatTime(entry.mtime)}</span>
          </div>
        ))}
      </div>

      <div className={`files-help${dropDirectory ? ' files-drop-hint' : ''}`} title={dropDirectory ? '松开放入 ' + dropDirectory + '；本机文件上传，远程文件移动，同名文件不覆盖' : '拖入上传 · 拖到文件夹移动 · ↗ 拖到本机下载 · 拖到终端插入路径'}>{dropDirectory ? '松开：' + (dropDirectory === path ? '当前目录' : dropDirectory) + ' · 同名文件不覆盖' : '拖入上传 · 拖到文件夹移动 · ↗ 拖到本机下载 · 拖到终端插入路径'}</div>

      {selected && (
        <div
          className="files-selection"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-elevated)'
          }}
        >
          <span className="mono" style={{ flex: 1, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {selected.path}
          </span>
          {selected.type !== 'directory' && <button className="btn btn-sm" onClick={() => setEditorEntry(selected)}>编辑</button>}
          {selected.type !== 'directory' && <button className="btn btn-sm" onClick={() => doDownload(selected)}>
            下载
          </button>}
          <button className="btn btn-sm" onClick={() => doRename(selected)}>
            重命名
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => doDelete(selected)}>
            删除
          </button>
        </div>
      )}
      {active && menu && <FileContextMenu x={menu.x} y={menu.y} onClose={closeMenu} actions={menu.entry ? [
        { label: menu.entry.type === 'directory' ? '打开目录' : '编辑文件', shortcut: 'Enter', run: () => enter(menu.entry!) },
        ...(menu.entry.type !== 'directory' ? [{ label: '下载', run: () => { void doDownload(menu.entry!) } }] : []),
        { label: '复制路径', run: () => { void copyPath(menu.entry!.path) } },
        { label: '重命名', shortcut: 'F2', run: () => doRename(menu.entry!) },
        { label: menu.entry.type === 'directory' ? '删除空目录' : '删除文件', shortcut: 'Delete', danger: true, run: () => { void doDelete(menu.entry!) } }
      ] : [
        { label: '新建文件', run: () => doCreate('file') },
        { label: '新建目录', run: () => doCreate('mkdir') },
        { label: '上传文件', run: () => { void doUpload() } },
        { label: '刷新', run: refresh },
        { label: '复制当前目录路径', run: () => { void copyPath(path) } }
      ]} />}
      {editorEntry && <FileEditor key={`${sessionId}:${editorEntry.path}`} sessionId={sessionId} path={editorEntry.path} active={active} onClose={() => setEditorEntry(null)} onSaved={refresh} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${Number((n / 1024).toFixed(1))} KB`
  if (n < 1024 ** 3) return `${Number((n / 1024 / 1024).toFixed(1))} MB`
  if (n < 1024 ** 4) return `${Number((n / 1024 ** 3).toFixed(2))} GB`
  return `${Number((n / 1024 ** 4).toFixed(2))} TB`
}

function formatTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
