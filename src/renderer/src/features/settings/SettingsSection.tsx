import { useEffect, useState, type ReactNode } from 'react'
import Icon from '../../components/Icon'

const storagePrefix = 'omnidesk.settings.expanded.'
const revealEvent = 'omnidesk:settings-section'

export function revealSettingsSection(id: string): void {
  localStorage.setItem(storagePrefix + id, 'true')
  window.dispatchEvent(new CustomEvent(revealEvent, { detail: id }))
}

export default function SettingsSection({ id, title, description, children }: {
  id: string
  title: string
  description: string
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem(storagePrefix + id) === 'true')
  useEffect(() => {
    const reveal = (event: Event) => { if ((event as CustomEvent<string>).detail === id) setExpanded(true) }
    window.addEventListener(revealEvent, reveal)
    return () => window.removeEventListener(revealEvent, reveal)
  }, [id])
  return <details className="settings-section" data-settings-section={id} open={expanded} onToggle={event => {
    const next = event.currentTarget.open
    setExpanded(next)
    localStorage.setItem(storagePrefix + id, String(next))
  }}>
    <summary className="settings-section-summary"><span><strong>{title}</strong><small>{description}</small></span><Icon name="chevron" size={15} /></summary>
    <div className="settings-section-content">{children}</div>
  </details>
}