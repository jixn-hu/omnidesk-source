import { useRef, useState } from 'react'
import type { MonitorNode } from '@shared/monitoring'

export default function MonitorDeleteDialog({ node, onClose, onDeleted }: { node: MonitorNode; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), running = useRef(false)
  const remove = async () => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try {
      const result = await window.omnidesk.monitoring.removeNode(node.id)
      if (!result.ok) { setError(result.message); return }
      window.dispatchEvent(new Event('omnidesk:monitor-nodes-changed')); onDeleted()
    } catch { setError('删除失败，请检查监控服务连接后重试') }
    finally { running.current = false; setBusy(false) }
  }
  return <div className="modal-overlay monitor-dialog-overlay" onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="modal monitor-confirm" role="dialog" aria-modal="true" aria-labelledby="monitor-delete-title">
    <header className="modal-header"><h2 id="monitor-delete-title">删除监控节点</h2></header><div className="modal-body"><p>确定删除「{node.name}」？</p><p className="field-hint">此节点的指标、流量历史和提醒记录会删除，采集令牌立即失效。SSH 连接配置保留；VPS 上的采集服务不会自动卸载。</p>{error && <p role="alert" className="alert alert-danger">{error}</p>}</div>
    <footer className="modal-footer"><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn btn-danger" disabled={busy} onClick={() => void remove()}>{busy ? '删除中…' : '确认删除节点'}</button></footer>
  </section></div>
}
