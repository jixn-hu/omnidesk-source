import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface TabMenuAction {
  label: string
  disabled?: boolean
  run: () => void
}

export default function TabContextMenu({ x, y, actions, onClose }: {
  x: number
  y: number
  actions: TabMenuAction[]
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const menu = menuRef.current!
    const previous = document.activeElement as HTMLElement | null
    const bounds = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))
    })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) onClose() }
    const dismiss = () => onClose()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      if (menu.contains(document.activeElement) && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [x, y, onClose])

  return createPortal(<div ref={menuRef} role="menu" aria-label="服务器窗口操作" className="tab-context-menu" style={position}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...menuRef.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus({ preventScroll: true })
    }}>
    {actions.map(action => <button key={action.label} role="menuitem" disabled={action.disabled}
      onClick={() => { onClose(); action.run() }}>{action.label}</button>)}
  </div>, document.body)
}
