import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface MenuAction { label: string; shortcut?: string; danger?: boolean; run: () => void }

export default function FileContextMenu({ x: left, y: top, actions, onClose }: { x: number; y: number; actions: MenuAction[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left, top })

  useLayoutEffect(() => {
    const menu = menuRef.current!
    const previous = document.activeElement as HTMLElement | null
    const bounds = menu.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) })
    menu.querySelector('button')?.focus()
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) onClose() }
    const resize = () => onClose()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    window.addEventListener('blur', resize)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', resize)
      window.removeEventListener('blur', resize)
      if (menu.contains(document.activeElement)) previous?.focus()
    }
  }, [left, top, onClose])

  return createPortal(<div ref={menuRef} role="menu" aria-label="远程文件操作" className="file-context-menu" style={position} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...menuRef.current!.querySelectorAll('button')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }}>
    {actions.map(action => <button key={action.label} role="menuitem" className={action.danger ? 'is-danger' : undefined} onClick={() => { onClose(); action.run() }}><span>{action.label}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>)}
  </div>, document.body)
}
