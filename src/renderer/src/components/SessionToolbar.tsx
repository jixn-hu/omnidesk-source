import { useCallback, useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../store/app'
import TabContextMenu from './TabContextMenu'

export default function SessionToolbar({ active, children }: { active: boolean; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const activeTab = useApp(state => state.tabs.find(tab => tab.id === state.activeTabId))
  const connection = useApp(state => state.connections.find(item => item.id === activeTab?.connectionId))
  const closeMenu = useCallback(() => setMenu(null), [])
  useLayoutEffect(() => { setTarget(document.getElementById('session-toolbar-slot')) }, [])
  useLayoutEffect(() => { setMenu(null) }, [active, activeTab?.id])
  const canInstall = connection && (activeTab?.kind === 'ssh' || activeTab?.kind === 'rdp')
  return active && target ? createPortal(<div style={{ display: 'contents' }} onContextMenu={event => {
    if (!canInstall) return
    event.preventDefault(); event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY })
  }}>{children}{menu && canInstall && <TabContextMenu {...menu} onClose={closeMenu} actions={[
    { label: '安装监控…', run: () => useApp.setState({ monitorInstallConnectionId: connection.id }) }
  ]} />}</div>, target) : null
}
