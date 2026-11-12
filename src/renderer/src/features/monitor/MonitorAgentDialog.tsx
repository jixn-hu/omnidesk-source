import { useEffect, useState } from 'react'
import type { MonitorNode } from '@shared/monitoring'
import MonitorAgentInstall from './MonitorAgentInstall'
import { useApp } from '../../store/app'
import './monitoring.css'

export default function MonitorAgentDialog({ node, connectionId, onClose, onChanged }: { node?: MonitorNode; connectionId?: string; onClose: () => void; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false)
  const scope = useApp(state => state.accountServerUrl + '|' + (state.accountUser?.id ?? ''))
  useEffect(() => { window.addEventListener('omnidesk:account-changed', onClose); return () => window.removeEventListener('omnidesk:account-changed', onClose) }, [onClose])
  return <div className="modal-overlay monitor-dialog-overlay" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="modal monitor-editor" role="dialog" aria-modal="true" aria-labelledby="monitor-install-title">
    <header className="modal-header"><h2 id="monitor-install-title">{node ? node.name + ' · 采集端' : '加入服务器监控'}</h2><button className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose} aria-label="关闭采集端安装">关闭</button></header>
    <div className="modal-body"><MonitorAgentInstall key={scope} nodeId={node?.id} initialNode={node} defaultConnectionId={connectionId} onBusyChange={setBusy} onChanged={onChanged} /></div>
    <footer className="modal-footer"><button className="btn" disabled={busy} onClick={onClose}>完成</button></footer>
  </section></div>
}
