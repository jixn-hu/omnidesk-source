import { createContext, useContext, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useApp, useSessionForConnection } from '../store/app'
import type { Connection } from '@shared/types'
import Icon from './Icon'
import { useAppearance } from '../store/appearance'
import ConnectionCheckBadge from './ConnectionCheckBadge'
import { formatConnectionAddress, matchesConnection } from '@shared/connection-identity'

interface ConnectionFolder {
  name: string
  path: string
  count: number
  connections: Connection[]
  children: Map<string, ConnectionFolder>
  category?: 'tag' | 'account'
  value?: string
}

const CONNECTION_DRAG = 'application/x-omnidesk-connection';
type DropDestination = { kind: Connection['kind']; group?: string; tag?: string };
const DirectoryDrag = createContext<{
  start: (event: DragEvent, connection: Connection) => void;
  end: () => void;
  target: (destination: DropDestination) => { onDragOver(event: DragEvent<HTMLElement>): void; onDragLeave(event: DragEvent<HTMLElement>): void; onDrop(event: DragEvent<HTMLElement>): void; 'data-dropping': boolean };
}>({ start: () => {}, end: () => {}, target: () => ({ onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {}, 'data-dropping': false }) });

interface Props {
  onEdit: (id: string) => void
}

export default function Sidebar({ onEdit }: Props) {
  const connections = useApp((s) => s.connections)
  const layout = useAppearance(state => state.sidebarLayout)
  const openTab = useApp((s) => s.openTab)
  const activeTabId = useApp((s) => s.activeTabId)
  const tabs = useApp((s) => s.tabs)
  const accountUser = useApp(state => state.accountUser)
  const vaultStatus = useApp(state => state.vaultStatus)
  useEffect(() => {
    let active = true
    void window.omnidesk.account.status().then(result => { if (active && result.ok) useApp.setState({ accountUser: result.data.user }) }).catch(() => {})
    return () => { active = false }
  }, [vaultStatus])
  const [folded, setFolded] = useState(() => localStorage.getItem('omnidesk.sidebar.folded') === 'true')
  const fold = (value: boolean) => { setFolded(value); localStorage.setItem('omnidesk.sidebar.folded', String(value)) }
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('omnidesk.sidebar.collapsed') ?? '[]')
      return new Set(Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string').map(value => value.replace(/\s*[\\/]\s*/g, ' / ')) : [])
    } catch { return new Set() }
  })
  const [dragging, setDragging] = useState<Connection | null>(null)
  const [dropTarget, setDropTarget] = useState('')
  const [directoryNotice, setDirectoryNotice] = useState<{ error: boolean; text: string } | null>(null)
  const drag = {
    start: (event: DragEvent, connection: Connection) => {
      if ((event.target as HTMLElement).closest('.conn-item-menu')) { event.preventDefault(); return }
      event.dataTransfer.effectAllowed = 'copyMove'
      event.dataTransfer.setData(CONNECTION_DRAG, JSON.stringify({ id: connection.id, kind: connection.kind }))
      setDragging(connection)
    },
    end: () => { setDragging(null); setDropTarget('') },
    target: (destination: DropDestination) => {
      const key = JSON.stringify(destination)
      return {
        'data-dropping': dropTarget === key,
        onDragOver: (event: DragEvent<HTMLElement>) => {
          if (!event.dataTransfer.types.includes(CONNECTION_DRAG) || (dragging && dragging.kind !== destination.kind)) return
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = destination.tag ? 'copy' : 'move'; setDropTarget(key)
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(current => current === key ? '' : current) },
        onDrop: (event: DragEvent<HTMLElement>) => {
          event.preventDefault(); event.stopPropagation(); setDropTarget(''); setDragging(null)
          void (async () => {
            try {
              const payload = JSON.parse(event.dataTransfer.getData(CONNECTION_DRAG))
              const connection = useApp.getState().connections.find(item => item.id === payload.id && item.kind === destination.kind)
              if (!connection) throw new Error('请从当前连接目录拖动服务器')
              if (destination.tag && connection.tags?.includes(destination.tag)) return
              const group = destination.group ?? ''
              if (destination.tag === undefined && (connection.group ?? '').replace(/\s*[\\/]\s*/g, ' / ') === group) return
              const changes = destination.tag ? { tags: { mode: 'add' as const, values: [destination.tag] } } : { group: group ? { mode: 'replace' as const, value: group } : { mode: 'clear' as const } }
              const result = await window.omnidesk.connections.batchMetadata({ items: [{ id: connection.id, updatedAt: connection.updatedAt }], changes })
              if (!result.ok) throw new Error(result.message)
              useApp.getState().setConnections(result.data)
              setDirectoryNotice({ error: false, text: destination.tag ? '已添加标签：' + destination.tag : '已移至：' + (group || '未分组') })
            } catch (error) { setDirectoryNotice({ error: true, text: error instanceof Error ? error.message : '移动失败，请重试' }) }
          })()
        }
      }
    }
  }
  const searchRef = useRef<HTMLInputElement>(null)
  const [width, setWidth] = useState(() => Math.max(228, Math.min(380, Number(localStorage.getItem('omnidesk.sidebar.width')) || 264)))
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
      if (document.querySelector('[aria-modal="true"]')) return
      const target = event.target as HTMLElement
      if (target.closest('.terminal-workspace, .desktop-workspace') && !event.shiftKey) return
      if (target.closest('input, textarea, select') && !event.shiftKey) return
      event.preventDefault()
      fold(false)
      window.setTimeout(() => searchRef.current?.focus(), 0)
      searchRef.current?.select()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])

  const activeTab = tabs.find((t) => t.id === activeTabId)

  const sections = useMemo(() => {
    const matched = connections.filter(connection => matchesConnection(connection, query))
    return (['ssh', 'rdp'] as const).map(kind => {
      const list = matched.filter(connection => connection.kind === kind)
      const groups = new Map<string, ConnectionFolder>()
      const flatGroups = new Map<string, ConnectionFolder>()
      const categories = new Map<string, ConnectionFolder>()
      for (const connection of list) {
        const values = layout === 'tags' ? (connection.tags?.length ? connection.tags : ['']) : [connection.username || '']
        for (const value of values) {
          const name = value || (layout === 'tags' ? '未标记' : '未填写账号')
          let folder = categories.get(value)
          if (!folder) { folder = { name, path: 'category:' + value, count: 0, connections: [], children: new Map(), category: layout === 'tags' ? 'tag' : 'account', value }; categories.set(value, folder) }
          folder.count++; folder.connections.push(connection)
        }
        const names = (connection.group ?? '').split(/[\\/]/).map(name => name.trim()).filter(Boolean)
        if (!names.length) names.push('未分组')
        const groupPath = names.join(' / ')
        let flatGroup = flatGroups.get(groupPath)
        if (!flatGroup) {
          flatGroup = { name: groupPath, path: groupPath, count: 0, connections: [], children: new Map() }
          flatGroups.set(groupPath, flatGroup)
        }
        flatGroup.count++
        flatGroup.connections.push(connection)
        let children = groups
        const path: string[] = []
        for (const name of names) {
          path.push(name)
          let folder = children.get(name)
          if (!folder) {
            folder = { name, path: path.join(' / '), count: 0, connections: [], children: new Map() }
            children.set(name, folder)
          }
          folder.count++
          if (path.length === names.length) folder.connections.push(connection)
          children = folder.children
        }
      }
      return { kind, label: kind === 'ssh' ? 'SSH 终端' : 'RDP 桌面', count: list.length, connections: list, groups, flatGroups, categories }
    })
  }, [connections, query, layout])
  const matchedCount = sections.reduce((total, section) => total + section.count, 0)

  const toggleGroup = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      localStorage.setItem('omnidesk.sidebar.collapsed', JSON.stringify([...next]))
      return next
    })
  }

  const openConnection = (conn: Connection) => {
    if (conn.kind === 'rdp') {
      openTab({ kind: 'rdp', title: conn.name, connectionId: conn.id, status: 'idle' })
    } else {
      openTab({ kind: 'ssh', title: conn.name, connectionId: conn.id, status: 'idle' })
    }
  }

  if (folded) return <aside className="sidebar-rail">
    <button className="btn btn-ghost btn-icon" aria-label="展开侧栏" title="展开侧栏" onClick={() => fold(false)}><Icon name="chevron" size={18} /></button>
    <button className="btn btn-ghost btn-icon" title="服务器管理" onClick={() => openTab({ id: 'tab-servers', kind: 'servers', title: '服务器管理', status: 'idle' })}><Icon name="server" size={18} /></button>
    <button className="btn btn-ghost btn-icon" title="公共凭据" onClick={() => openTab({ id: 'tab-credentials', kind: 'credentials', title: '公共凭据', status: 'idle' })}><Icon name="key" size={18} /></button>
    <button className="btn btn-ghost btn-icon" title="AI 助手" onClick={() => openTab({ id: 'tab-ai', kind: 'ai', title: 'AI 助手', status: 'idle' })}><Icon name="assistant" size={18} /></button>
    <button className="btn btn-ghost btn-icon" title="设置与备份" onClick={() => openTab({ id: 'tab-settings', kind: 'settings', title: '设置', status: 'idle' })}><Icon name="settings" size={18} /></button>
    <button className="btn btn-ghost btn-icon" title="共享服务器" aria-label="共享服务器" onClick={() => openTab({ id: 'tab-shared-servers', kind: 'shared-servers', title: '共享服务器', status: 'idle' })}><Icon name="layers" size={17} /></button>
    <button className="btn btn-ghost btn-icon sidebar-account-entry" aria-label="账号与同步" title={accountUser ? accountUser.username + ' · 账号与同步' : '登录账号（可选）'} onClick={() => openTab({ id: 'tab-account', kind: 'account', title: '账号与同步', status: 'idle' })}><Icon name="user" size={17} /></button>
  </aside>

  return (
    <DirectoryDrag.Provider value={drag}><aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="sidebar-logo"><Icon name="layers" size={20} /></div>
          <div><span className="sidebar-title">OmniDesk</span><span className="sidebar-subtitle">REMOTE WORKSPACE</span></div>
        </div>
        <div className="sidebar-actions"><button className="btn btn-ghost btn-icon" aria-label="收起侧栏" title="收起侧栏" onClick={() => fold(true)}><Icon name="chevron" size={15} /></button></div>
      </div>

      <div className="sidebar-search">
        <Icon name="search" size={15} />
        <input
          ref={searchRef}
          aria-label="搜索连接"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="名称、地址、备注、标签…"
          spellCheck={false}
        />
        <kbd title="Ctrl+Shift+K">⌃ K</kbd>
      </div>

      <button className="btn sidebar-manager" onClick={() => openTab({ id: 'tab-servers', kind: 'servers', title: '服务器管理', status: 'idle' })}><Icon name="server" size={16} />服务器管理<span>{connections.length}</span></button>
      <button className={`btn sidebar-manager shared-servers-entry ${activeTab?.kind === 'shared-servers' ? 'is-active' : ''}`} onClick={() => openTab({ id: 'tab-shared-servers', kind: 'shared-servers', title: '共享服务器', status: 'idle' })}><Icon name="layers" size={16} />共享服务器</button>
      <div className="sidebar-section-heading"><span>{query.trim() ? '搜索结果' : '连接目录'}</span><span>{matchedCount}</span></div>

      {directoryNotice && <div className={directoryNotice.error ? 'sidebar-directory-notice is-error' : 'sidebar-directory-notice'} role={directoryNotice.error ? 'alert' : 'status'}>{directoryNotice.text}<button aria-label="关闭目录提示" onClick={() => setDirectoryNotice(null)}>×</button></div>}
      <div className="sidebar-body" data-layout={layout}>
        {matchedCount === 0 && (
          <div className="conn-empty">
            {query ? (
              <>没有匹配「{query}」的主机</>
            ) : (
              <>
                还没有连接
                <br />
                点右上角「新建连接」
              </>
            )}
          </div>
        )}

        {layout === 'flat' ? <div className="sidebar-flat-list">{sections.flatMap(section => section.connections).map(connection => <ConnectionRow key={connection.id} conn={connection} active={activeTab?.connectionId === connection.id} onOpen={() => openConnection(connection)} onEdit={() => onEdit(connection.id)} />)}</div> : sections.filter(section => section.count > 0).map(section => {
          const sectionCollapsed = !query.trim() && collapsed.has(section.kind)
          return (
            <section className="sidebar-protocol" key={section.kind} data-protocol={section.kind} aria-label={section.label}>
              <button className="sidebar-protocol-heading" {...drag.target({ kind: section.kind, group: '' })} title="将服务器拖到这里可移出文件夹" aria-expanded={!sectionCollapsed} onClick={() => toggleGroup(section.kind)}>
                <span className="group-caret" data-open={!sectionCollapsed} aria-hidden="true">▼</span>
                <span className={`sidebar-protocol-icon ${section.kind}`}><Icon name={section.kind === 'ssh' ? 'terminal' : 'monitor'} size={15} /></span>
                <strong>{section.label}</strong><span className="sidebar-protocol-count">{section.count}</span>
              </button>
              {!sectionCollapsed && <div className={layout === 'tree' ? 'sidebar-tree-children' : 'sidebar-grouped-list'}>{sortFolders(layout === 'tree' ? section.groups : layout === 'grouped' ? section.flatGroups : section.categories).map(folder => <ConnectionFolderBranch key={folder.path} folder={folder} kind={section.kind} collapsed={collapsed} searching={!!query.trim()} onToggle={toggleGroup} activeId={activeTab?.connectionId} onOpen={openConnection} onEdit={onEdit} />)}</div>}
            </section>
          )
        })}
      </div>

      <div className="sidebar-footer">
        <button className={`btn btn-ghost ${activeTab?.kind === 'ai' ? 'is-active' : ''}`} onClick={() => openTab({ id: 'tab-ai', kind: 'ai', title: 'AI 助手', status: 'idle' })}><Icon name="assistant" size={17} />AI 助手<span className="sidebar-new-label">服务器 · 运维</span></button>
        <button className={`btn btn-ghost ${activeTab?.kind === 'credentials' ? 'is-active' : ''}`} onClick={() => openTab({ kind: 'credentials', title: '公共凭据', status: 'idle', id: 'tab-credentials' })}><Icon name="key" size={17} />公共凭据<span className="sidebar-new-label">账号 · 密钥</span></button>
        <button
          className={`btn btn-ghost ${activeTab?.kind === 'external' ? 'is-active' : ''}`}
          onClick={() =>
            openTab({ kind: 'external', title: '开放能力', status: 'idle', id: 'tab-external' })
          }
        >
          <Icon name="link" size={17} />开放能力<span className="sidebar-new-label">AI / API</span>
        </button>
        <button
          className={`btn btn-ghost ${activeTab?.kind === 'settings' ? 'is-active' : ''}`}
          onClick={() =>
            openTab({ kind: 'settings', title: '设置', status: 'idle', id: 'tab-settings' })
          }
        >
          <Icon name="settings" size={17} />设置
        </button>
        <button aria-label="账号与同步" title="可选功能 · 个人同步与配置共享，不影响本机连接" className={`btn btn-ghost sidebar-account-entry ${activeTab?.kind === 'account' ? 'is-active' : ''}`} onClick={() => openTab({ id: 'tab-account', kind: 'account', title: '账号与同步', status: 'idle' })}><Icon name="user" size={16} /><span>{accountUser?.username ?? '登录账号'}</span><small>{accountUser ? '账号与同步' : '可选'}</small></button>
      </div>
      <div className="sidebar-resize-handle" role="separator" aria-label="调整侧边栏宽度" aria-orientation="vertical" aria-valuemin={228} aria-valuemax={380} aria-valuenow={width} tabIndex={0}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(228, Math.min(380, event.clientX))) }}
        onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); localStorage.setItem('omnidesk.sidebar.width', String(width)) }}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = Math.max(228, Math.min(380, width + (event.key === 'ArrowRight' ? 12 : -12))); setWidth(next); localStorage.setItem('omnidesk.sidebar.width', String(next)) } }} />
    </aside></DirectoryDrag.Provider>
  )
}

/* ------------------------------------------------------------------ */

function sortFolders(folders: Map<string, ConnectionFolder>): ConnectionFolder[] {
  return [...folders.values()].sort((first, second) => first.name === second.name ? 0 : first.name === '未分组' ? 1 : second.name === '未分组' ? -1 : first.name.localeCompare(second.name, 'zh-CN'))
}

function ConnectionFolderBranch({ folder, kind, collapsed, searching, onToggle, activeId, onOpen, onEdit }: {
  folder: ConnectionFolder
  kind: Connection['kind']
  collapsed: Set<string>
  searching: boolean
  onToggle: (key: string) => void
  activeId?: string
  onOpen: (connection: Connection) => void
  onEdit: (id: string) => void
}) {
  const drag = useContext(DirectoryDrag)
  const destination = folder.category === 'tag' && folder.value ? { kind, tag: folder.value } : !folder.category ? { kind, group: folder.path === '未分组' && folder.connections.every(connection => !connection.group) ? '' : folder.path } : null
  const key = kind + ':' + folder.path
  const expanded = searching || !collapsed.has(key)
  return <div className="sidebar-connection-group" data-group-path={folder.path}>
    <button className="group-label" {...(destination ? drag.target(destination) : {})} aria-label={folder.path} aria-expanded={expanded} title={folder.path} onClick={() => onToggle(key)}>
      <span className="group-caret" data-open={expanded} aria-hidden="true">▼</span>
      <span className="sidebar-folder-icon"><Icon name={folder.category === 'tag' ? 'tag' : folder.category === 'account' ? 'user' : expanded ? 'folderOpen' : 'folder'} size={14} /></span>
      <span className="sidebar-group-name">{folder.name}</span><span className="sidebar-group-count">{folder.count}</span>
    </button>
    {expanded && <div className="sidebar-tree-children" role="group" aria-label={folder.path}>
      {sortFolders(folder.children).map(child => <ConnectionFolderBranch key={child.path} folder={child} kind={kind} collapsed={collapsed} searching={searching} onToggle={onToggle} activeId={activeId} onOpen={onOpen} onEdit={onEdit} />)}
      {folder.connections.map(connection => <ConnectionRow key={connection.id} conn={connection} active={activeId === connection.id} onOpen={() => onOpen(connection)} onEdit={() => onEdit(connection.id)} />)}
    </div>}
  </div>
}

function ConnectionRow({
  conn,
  active,
  onOpen,
  onEdit
}: {
  conn: Connection
  active: boolean
  onOpen: () => void
  onEdit: () => void
}) {
  const drag = useContext(DirectoryDrag)
  const details = useAppearance()
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 })
  const toggleMenu = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    setMenuPosition({ left: Math.max(8, rect.right - 174), top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - 260)) })
    setMenuOpen((value) => !value)
  }
  const openTab = useApp((s) => s.openTab)
  const session = useSessionForConnection(conn.id)
  const remoteStatus = useApp((state) => state.tabs.find((tab) => tab.kind === 'rdp' && tab.connectionId === conn.id)?.status)
  const connected = !!session || remoteStatus === 'connected'
  const address = formatConnectionAddress(conn.host, conn.port)
  const showAddress = conn.name !== conn.host && conn.name !== address
  const description = [conn.name, address, conn.group && '分组：' + conn.group, conn.tags?.length && '标签：' + conn.tags.join('、'), conn.note && '备注：' + conn.note].filter(Boolean).join('\n')

  /** 只有 SSH 连接且已连上时，才提供文件/监控入口 */
  const canOpenFiles = conn.kind === 'ssh' && session

  return (
    <div style={{ position: 'relative' }}>
      <div className="conn-item" draggable onDragStart={event => drag.start(event, conn)} onDragEnd={drag.end} data-active={active} data-connection-id={conn.id}>
        <button className="conn-item-open" aria-label={`打开连接 ${conn.name}`} title={description} onClick={onOpen}>
          <span className={`conn-item-symbol ${conn.kind}`}>
            <Icon name={conn.kind === 'ssh' ? 'terminal' : 'monitor'} size={14} />
            <span className={`dot ${connected ? 'dot-connected' : remoteStatus === 'connecting' ? 'dot-connecting' : 'dot-idle'}`} title={connected ? '已连接' : remoteStatus === 'connecting' ? '连接中' : '未连接'} />
          </span>
          <span className="conn-item-main">
            <span className="conn-item-name">{conn.name === conn.host ? address : conn.name}</span>
            {(details.sidebarShowAddress && showAddress || details.sidebarShowUsername && conn.username) && <span className="conn-item-host">{details.sidebarShowUsername && conn.username ? conn.username + (details.sidebarShowAddress && showAddress ? '@' : '') : ''}{details.sidebarShowAddress && showAddress ? address : ''}</span>}
            {details.sidebarShowTags && !!conn.tags?.length && <span className="conn-item-tags">{conn.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}{conn.tags.length > 3 && <small>+{conn.tags.length - 3}</small>}</span>}
            {details.sidebarShowNote && conn.note && <span className="conn-item-note">{conn.note}</span>}
          </span>
        </button>
        <ConnectionCheckBadge connectionId={conn.id} onEdit={onEdit} compact />
        <button
          className="conn-item-menu"
          aria-label={`管理连接 ${conn.name}`}
          onClick={(e) => {
            e.stopPropagation()
            toggleMenu(e.currentTarget)
          }}
        >
          ⋯
        </button>
      </div>

      {menuOpen && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            onClick={() => setMenuOpen(false)}
          />
          <div
            className="ctx-menu"
            style={{ position: 'fixed', left: menuPosition.left, top: menuPosition.top, zIndex: 70 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                setMenuOpen(false)
                onOpen()
              }}
            >
              打开连接
            </button>
            <button onClick={() => { setMenuOpen(false); openTab({ kind: conn.kind, title: conn.name, connectionId: conn.id, status: 'idle', newSession: true }) }}>新建独立会话</button>
            {canOpenFiles && (
              <>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    openTab({
                      kind: 'files',
                      title: `${conn.name} · 文件`,
                      connectionId: conn.id,
                      sessionId: session!.id,
                      status: 'connected'
                    })
                  }}
                >
                  文件管理
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    openTab({
                      kind: 'monitor',
                      title: `${conn.name} · 监控`,
                      connectionId: conn.id,
                      sessionId: session!.id,
                      status: 'connected'
                    })
                  }}
                >
                  服务器监控
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    openTab({
                      kind: 'forwards',
                      title: `${conn.name} · 转发`,
                      connectionId: conn.id,
                      sessionId: session!.id,
                      status: 'connected'
                    })
                  }}
                >
                  端口转发
                </button>
              </>
            )}
            <div className="ctx-divider" />
            <button
              onClick={() => {
                setMenuOpen(false)
                onEdit()
              }}
            >
              编辑
            </button>
          </div>
        </>
      )}
    </div>
  )
}
