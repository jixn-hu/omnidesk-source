import { useCallback, useState } from 'react'
import TabContextMenu, { type TabMenuAction } from './TabContextMenu'
import { useApp } from '../store/app'
import Icon from './Icon'
import { formatConnectionAddress } from '@shared/connection-identity'

export default function TabBar() {
  const tabs = useApp((s) => s.tabs)
  const activeTabId = useApp((s) => s.activeTabId)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const closeTab = useApp((s) => s.closeTab)
  const connections = useApp(state => state.connections)
  const sessions = useApp((s) => s.sessions)

  const [menu, setMenu] = useState<{ x: number; y: number; tabId?: string } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const menuIndex = menu?.tabId ? tabs.findIndex(tab => tab.id === menu.tabId) : -1
  const disconnectedTabs = tabs.filter(tab => {
    if (!['ssh', 'rdp', 'shared-session'].includes(tab.kind)) return false
    const status = sessions.find(session => session.id === tab.sessionId)?.status ?? tab.status
    return status !== 'connected' && status !== 'connecting'
  })
  const closeWindows = (ids: string[]) => ids.forEach(closeTab)
  const menuActions: TabMenuAction[] = [
    ...(menuIndex < 0 ? [] : [
      { label: '关闭当前窗口', run: () => closeTab(menu!.tabId!) },
      { label: '关闭其他窗口', disabled: tabs.length <= 1, run: () => closeWindows(tabs.filter(tab => tab.id !== menu!.tabId).map(tab => tab.id)) },
      { label: '关闭右侧窗口', disabled: menuIndex === tabs.length - 1, run: () => closeWindows(tabs.slice(menuIndex + 1).map(tab => tab.id)) }
    ]),
    { label: '关闭所有窗口', disabled: tabs.length === 0, run: () => closeWindows(tabs.map(tab => tab.id)) },
    { label: '关闭已断开连接的服务器', disabled: disconnectedTabs.length === 0, run: () => closeWindows(disconnectedTabs.map(tab => tab.id)) }
  ]

  return (
    <div className="tabbar" onContextMenu={event => {
      event.preventDefault()
      setMenu({ x: event.clientX, y: event.clientY })
    }}>
      {tabs.length === 0 && <span className="tabbar-placeholder"><Icon name="home" size={14} />工作台</span>}
      {tabs.map((tab) => {
        const connection = connections.find(item => item.id === tab.connectionId)
        const peers = tabs.filter(item => item.connectionId === tab.connectionId && item.kind === tab.kind)
        const label = tab.title + (tab.connectionId && peers.length > 1 ? ` · ${peers.indexOf(tab) + 1}` : '')
        const session = tab.sessionId ? sessions.find((s) => s.id === tab.sessionId) : undefined
        const dotClass =
          (session?.status ?? tab.status) === 'connected'
            ? 'dot-connected'
            : (session?.status ?? tab.status) === 'connecting'
              ? 'dot-connecting'
              : (session?.status ?? tab.status) === 'error'
                ? 'dot-error'
                : 'dot-idle'

        return (
          <div
            key={tab.id}
            className="tab"
            data-active={tab.id === activeTabId}
            onClick={() => setActiveTab(tab.id)}
            onContextMenu={event => {
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.focus()
              setMenu({ x: event.clientX, y: event.clientY, tabId: tab.id })
            }}
            title={tab.error || [label, connection ? `${connection.username}@${formatConnectionAddress(connection.host, connection.port)}` : '', connection?.note].filter(Boolean).join('\n')}
            role="tab"
            aria-selected={tab.id === activeTabId}
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
                event.preventDefault()
                const bounds = event.currentTarget.getBoundingClientRect()
                setMenu({ x: bounds.left, y: bounds.bottom, tabId: tab.id })
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setActiveTab(tab.id)
              }
            }}
          >
            <Icon name={tab.kind === 'ssh' ? 'terminal' : tab.kind === 'rdp' ? 'monitor' : tab.kind === 'ai' ? 'assistant' : tab.kind === 'credentials' ? 'key' : tab.kind === 'settings' ? 'settings' : tab.kind === 'files' ? 'folder' : 'layers'} size={14} />
            {(tab.kind === 'ssh' || tab.kind === 'rdp' || tab.kind === 'shared-session') && <span className={`dot ${dotClass}`} />}
            <span className="tab-title">{label}</span>
            <span
              className="tab-close"
              role="button"
              tabIndex={0}
              aria-label={`关闭标签 ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  closeTab(tab.id)
                }
              }}
            >
              ×
            </span>
          </div>
        )
      })}
      {menu && (!menu.tabId || menuIndex >= 0) && <TabContextMenu x={menu.x} y={menu.y} actions={menuActions} onClose={closeMenu} />}
    </div>
  )
}
