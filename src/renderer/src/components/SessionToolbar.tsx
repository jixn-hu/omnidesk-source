import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export default function SessionToolbar({ active, children }: { active: boolean; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setTarget(document.getElementById('session-toolbar-slot')) }, [])
  return active && target ? createPortal(children, target) : null
}
